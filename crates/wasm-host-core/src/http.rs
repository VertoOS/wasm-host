use std::{
    fmt,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

use crate::{CancellationSource, CancellationToken};

const HTTP_RESPONSE_EVENT_QUEUE_SIZE: usize = 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<HttpHeader>,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<HttpHeader>,
    pub body: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HttpRequestLimits {
    pub response_body_bytes: usize,
    pub wall_time: Option<Duration>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpBridgeErrorKind {
    InvalidRequest,
    InvalidResponse,
    UnsupportedScheme,
    GatewayUnavailable,
    AuthFailure,
    Cors,
    Timeout,
    Cancelled,
    Transport,
    ResponseTooLarge,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpBridgeError {
    pub kind: HttpBridgeErrorKind,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct HttpBridge {
    inner: Arc<HttpBridgeInner>,
}

#[derive(Debug)]
struct HttpBridgeInner {
    sender: tokio::sync::mpsc::Sender<HttpBridgeRequest>,
    sequence: AtomicU64,
}

#[derive(Clone, Debug)]
pub struct HttpBridgeRequest {
    pub id: u64,
    pub request: HttpRequest,
    cancellation: CancellationToken,
    response_sender: mpsc::SyncSender<HttpBridgeResponseEvent>,
}

#[derive(Debug)]
enum HttpBridgeResponseEvent {
    Body(Vec<u8>),
    Complete(std::result::Result<HttpResponse, HttpBridgeError>),
}

impl HttpHeader {
    pub fn new(
        name: impl Into<String>,
        value: impl Into<String>,
    ) -> std::result::Result<Self, HttpBridgeError> {
        let name = name.into().trim().to_ascii_lowercase();
        let value = value.into().trim().to_string();
        if name.is_empty() || !name.bytes().all(is_http_token_byte) {
            return Err(HttpBridgeError::invalid_request(
                "HTTP header names must be non-empty ASCII tokens",
            ));
        }
        if value.bytes().any(|byte| matches!(byte, b'\r' | b'\n')) {
            return Err(HttpBridgeError::invalid_request(
                "HTTP header values cannot contain CR or LF",
            ));
        }
        Ok(Self { name, value })
    }
}

impl HttpRequest {
    pub fn new(
        method: impl Into<String>,
        url: impl Into<String>,
        headers: Vec<HttpHeader>,
        body: Vec<u8>,
    ) -> std::result::Result<Self, HttpBridgeError> {
        let method = normalize_http_method(method.into())?;
        let url = normalize_http_url(url.into())?;
        Ok(Self {
            method,
            url,
            headers,
            body,
        })
    }
}

impl HttpResponse {
    pub fn new(
        status: u16,
        headers: Vec<HttpHeader>,
        body: Vec<u8>,
    ) -> std::result::Result<Self, HttpBridgeError> {
        if !(100..=599).contains(&status) {
            return Err(HttpBridgeError::invalid_response(format!(
                "HTTP response status must be between 100 and 599, got {status}"
            )));
        }
        Ok(Self {
            status,
            headers,
            body,
        })
    }
}

impl Default for HttpRequestLimits {
    fn default() -> Self {
        Self {
            response_body_bytes: 16 * 1024 * 1024,
            wall_time: Some(Duration::from_secs(30)),
        }
    }
}

impl HttpBridgeError {
    pub fn new(kind: HttpBridgeErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(HttpBridgeErrorKind::InvalidRequest, message)
    }

    pub fn invalid_response(message: impl Into<String>) -> Self {
        Self::new(HttpBridgeErrorKind::InvalidResponse, message)
    }

    pub fn unsupported_scheme(message: impl Into<String>) -> Self {
        Self::new(HttpBridgeErrorKind::UnsupportedScheme, message)
    }

    pub fn gateway_unavailable(message: impl Into<String>) -> Self {
        Self::new(HttpBridgeErrorKind::GatewayUnavailable, message)
    }

    pub fn auth_failure(message: impl Into<String>) -> Self {
        Self::new(HttpBridgeErrorKind::AuthFailure, message)
    }

    pub fn cors(message: impl Into<String>) -> Self {
        Self::new(HttpBridgeErrorKind::Cors, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(HttpBridgeErrorKind::Timeout, message)
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(HttpBridgeErrorKind::Cancelled, message)
    }

    pub fn transport(message: impl Into<String>) -> Self {
        Self::new(HttpBridgeErrorKind::Transport, message)
    }

    pub fn response_too_large(message: impl Into<String>) -> Self {
        Self::new(HttpBridgeErrorKind::ResponseTooLarge, message)
    }
}

impl fmt::Display for HttpBridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for HttpBridgeError {}

impl HttpBridgeRequest {
    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn respond(&self, response: HttpResponse) -> std::result::Result<(), HttpBridgeError> {
        self.response_sender
            .send(HttpBridgeResponseEvent::Complete(Ok(response)))
            .map_err(|_| HttpBridgeError::transport("HTTP response receiver closed"))
    }

    pub fn fail(&self, error: HttpBridgeError) -> std::result::Result<(), HttpBridgeError> {
        self.response_sender
            .send(HttpBridgeResponseEvent::Complete(Err(error)))
            .map_err(|_| HttpBridgeError::transport("HTTP response receiver closed"))
    }

    pub fn write_body_chunk(&self, chunk: Vec<u8>) -> std::result::Result<(), HttpBridgeError> {
        self.response_sender
            .send(HttpBridgeResponseEvent::Body(chunk))
            .map_err(|_| HttpBridgeError::transport("HTTP response receiver closed"))
    }
}

impl HttpBridge {
    pub fn new(capacity: usize) -> (Self, tokio::sync::mpsc::Receiver<HttpBridgeRequest>) {
        let (sender, receiver) = tokio::sync::mpsc::channel(capacity);
        (
            Self {
                inner: Arc::new(HttpBridgeInner {
                    sender,
                    sequence: AtomicU64::new(0),
                }),
            },
            receiver,
        )
    }

    pub fn request_blocking(
        &self,
        request: HttpRequest,
        limits: HttpRequestLimits,
        cancellation: CancellationToken,
    ) -> std::result::Result<HttpResponse, HttpBridgeError> {
        let id = self.inner.sequence.fetch_add(1, Ordering::AcqRel) + 1;
        let (response_sender, response_receiver) =
            mpsc::sync_channel(HTTP_RESPONSE_EVENT_QUEUE_SIZE);
        let request_cancellation = CancellationSource::new();
        let mut pending = Some(HttpBridgeRequest {
            id,
            request,
            cancellation: request_cancellation.token(),
            response_sender,
        });
        let deadline = limits.wall_time.map(|timeout| Instant::now() + timeout);

        while let Some(candidate) = pending.take() {
            if cancellation.is_cancelled() {
                request_cancellation.cancel();
                return Err(HttpBridgeError::cancelled("HTTP request cancelled"));
            }
            if deadline.is_some_and(|time| Instant::now() >= time) {
                request_cancellation.cancel();
                return Err(HttpBridgeError::timeout(
                    "HTTP request exceeded wall time limit",
                ));
            }

            match self.inner.sender.try_send(candidate) {
                Ok(()) => break,
                Err(tokio::sync::mpsc::error::TrySendError::Full(candidate)) => {
                    pending = Some(candidate);
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    request_cancellation.cancel();
                    return Err(HttpBridgeError::gateway_unavailable(
                        "HTTP bridge dispatcher is closed",
                    ));
                }
            }
        }

        let mut response_body = Vec::new();
        loop {
            if cancellation.is_cancelled() {
                request_cancellation.cancel();
                return Err(HttpBridgeError::cancelled("HTTP request cancelled"));
            }
            if deadline.is_some_and(|time| Instant::now() >= time) {
                request_cancellation.cancel();
                return Err(HttpBridgeError::timeout(
                    "HTTP request exceeded wall time limit",
                ));
            }

            let wait_time = deadline.map_or(Duration::from_millis(10), |time| {
                time.saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(10))
            });
            match response_receiver.recv_timeout(wait_time) {
                Ok(HttpBridgeResponseEvent::Body(chunk)) => {
                    if let Err(error) =
                        append_response_body(&mut response_body, chunk, limits.response_body_bytes)
                    {
                        request_cancellation.cancel();
                        return Err(error);
                    }
                }
                Ok(HttpBridgeResponseEvent::Complete(Ok(mut response))) => {
                    request_cancellation.cancel();
                    if let Err(error) = append_response_body(
                        &mut response_body,
                        std::mem::take(&mut response.body),
                        limits.response_body_bytes,
                    ) {
                        return Err(error);
                    }
                    response.body = response_body;
                    return Ok(response);
                }
                Ok(HttpBridgeResponseEvent::Complete(Err(error))) => {
                    request_cancellation.cancel();
                    return Err(error);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    request_cancellation.cancel();
                    return Err(HttpBridgeError::transport("HTTP response channel closed"));
                }
            }
        }
    }
}

fn append_response_body(
    body: &mut Vec<u8>,
    chunk: Vec<u8>,
    limit: usize,
) -> std::result::Result<(), HttpBridgeError> {
    let next_len = body
        .len()
        .checked_add(chunk.len())
        .ok_or_else(|| response_too_large_error(limit))?;
    if next_len > limit {
        return Err(response_too_large_error(limit));
    }
    body.extend_from_slice(&chunk);
    Ok(())
}

fn response_too_large_error(limit: usize) -> HttpBridgeError {
    HttpBridgeError::response_too_large(format!("HTTP response body exceeded {limit} bytes"))
}

fn normalize_http_method(method: String) -> std::result::Result<String, HttpBridgeError> {
    let method = method.trim().to_ascii_uppercase();
    if method.is_empty() || !method.bytes().all(is_http_token_byte) {
        return Err(HttpBridgeError::invalid_request(
            "HTTP method must be a non-empty ASCII token",
        ));
    }
    Ok(method)
}

fn normalize_http_url(url: String) -> std::result::Result<String, HttpBridgeError> {
    let url = url.trim().to_string();
    let Some((scheme, rest)) = url.split_once(':') else {
        return Err(HttpBridgeError::invalid_request(
            "HTTP request URL must include a scheme",
        ));
    };
    let scheme = scheme.to_ascii_lowercase();
    match scheme.as_str() {
        "http" | "https" => Ok(format!("{scheme}:{rest}")),
        _ => Err(HttpBridgeError::unsupported_scheme(format!(
            "unsupported HTTP bridge scheme: {scheme}"
        ))),
    }
}

fn is_http_token_byte(byte: u8) -> bool {
    matches!(
        byte,
        b'a'..=b'z'
            | b'A'..=b'Z'
            | b'0'..=b'9'
            | b'!'
            | b'#'
            | b'$'
            | b'%'
            | b'&'
            | b'\''
            | b'*'
            | b'+'
            | b'-'
            | b'.'
            | b'^'
            | b'_'
            | b'`'
            | b'|'
            | b'~'
    )
}
