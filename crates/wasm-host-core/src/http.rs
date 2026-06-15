use std::{
    fmt,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};

#[cfg(not(target_arch = "wasm32"))]
use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
};

use crate::{CancellationSource, CancellationToken};

const HTTP_RESPONSE_EVENT_QUEUE_SIZE: usize = 1;
const HTTP_REQUEST_BODY_EVENT_QUEUE_SIZE: usize = 1;
const HTTP_GATEWAY_EVENT_QUEUE_SIZE: usize = 16;
const HTTP_GATEWAY_RESPONSE_BODY_LIMIT: usize = 16 * 1024 * 1024;
#[cfg(not(target_arch = "wasm32"))]
const NATIVE_HTTP_HEADER_LIMIT: usize = 64 * 1024;
#[cfg(not(target_arch = "wasm32"))]
const NATIVE_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(not(target_arch = "wasm32"))]
const NATIVE_HTTP_IO_TIMEOUT: Duration = Duration::from_millis(100);
#[cfg(not(target_arch = "wasm32"))]
const NATIVE_HTTP_MAX_REDIRECTS: usize = 10;

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

pub struct HttpRequestBodyWriter {
    sender: mpsc::SyncSender<HttpRequestBodyEvent>,
    cancellation: CancellationToken,
    closed: bool,
}

pub struct GatewayHttpBridgeWorker {
    _handle: thread::JoinHandle<()>,
}

pub trait AsyncHttpBridgeTransport {
    fn dispatch<'a>(
        &'a self,
        request: GatewayHttpRequest,
        response: GatewayHttpResponseWriter,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = std::result::Result<(), HttpBridgeError>> + 'a>>;
}

pub trait GatewayHttpTransport: Send + Sync + 'static {
    fn dispatch(
        &self,
        request: GatewayHttpRequest,
        cancellation: CancellationToken,
    ) -> std::result::Result<GatewayHttpResponse, HttpBridgeError>;

    fn dispatch_with_response_writer(
        &self,
        request: GatewayHttpRequest,
        response: GatewayHttpResponseWriter,
        cancellation: CancellationToken,
    ) -> std::result::Result<(), HttpBridgeError> {
        response.respond(self.dispatch(request, cancellation)?)
    }
}

#[derive(Debug)]
pub struct GatewayHttpRequest {
    pub id: u64,
    pub method: String,
    pub url: String,
    pub headers: Vec<HttpHeader>,
    pub body: GatewayHttpRequestBodyReader,
}

#[derive(Debug)]
pub struct GatewayHttpRequestBodyReader {
    buffered: Option<Vec<u8>>,
    stream_request: Option<HttpBridgeRequest>,
}

#[derive(Clone, Debug)]
pub struct GatewayHttpResponseWriter {
    request: HttpBridgeRequest,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayHttpResponse {
    pub status: u16,
    pub headers: Vec<HttpHeader>,
    pub body: GatewayHttpResponseBody,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GatewayHttpResponseBody {
    Complete(Vec<u8>),
    Chunks(Vec<Vec<u8>>),
}

#[cfg(not(target_arch = "wasm32"))]
pub struct NativeHttpBridgeWorker {
    _handle: thread::JoinHandle<()>,
}

#[cfg(not(target_arch = "wasm32"))]
pub struct NativeGatewayHttpTransport {
    endpoint: String,
    bridge: HttpBridge,
    _worker: Arc<Mutex<NativeHttpBridgeWorker>>,
}

#[derive(Serialize)]
struct GatewayWireRequest {
    schema: u32,
    id: u64,
    method: String,
    url: String,
    headers: Vec<GatewayWireHeader>,
    body_chunks_base64: Vec<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum GatewayStreamWireRequestFrame {
    Request {
        schema: u32,
        id: u64,
        method: String,
        url: String,
        headers: Vec<GatewayWireHeader>,
    },
    BodyChunk {
        body_base64: String,
    },
    BodyEnd,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum GatewayStreamWireResponseFrame {
    Response {
        status: u16,
        #[serde(default)]
        headers: Vec<GatewayWireHeader>,
    },
    BodyChunk {
        body_base64: String,
    },
    BodyEnd,
    Error {
        kind: String,
        message: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct GatewayWireHeader {
    name: String,
    value: String,
}

#[derive(Debug, Deserialize)]
struct GatewayWireResponse {
    ok: bool,
    response: Option<GatewayWireSuccess>,
    error: Option<GatewayWireError>,
}

#[derive(Debug, Deserialize)]
struct GatewayWireSuccess {
    status: u16,
    #[serde(default)]
    headers: Vec<GatewayWireHeader>,
    #[serde(default)]
    body_base64: Option<String>,
    #[serde(default)]
    body_chunks_base64: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct GatewayWireError {
    kind: String,
    message: String,
}

struct GatewayStreamResponseDecoder {
    writer: GatewayHttpResponseWriter,
    buffer: Vec<u8>,
    response: Option<(u16, Vec<HttpHeader>)>,
    completed: bool,
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
    response_sender: tokio::sync::mpsc::Sender<HttpBridgeResponseEvent>,
    body_stream: Option<HttpRequestBodyStream>,
}

#[derive(Debug)]
enum HttpBridgeResponseEvent {
    Body(Vec<u8>),
    Complete(std::result::Result<HttpResponse, HttpBridgeError>),
}

#[derive(Debug)]
enum HttpRequestBodyEvent {
    Chunk(Vec<u8>),
    Complete(std::result::Result<(), HttpBridgeError>),
}

#[derive(Clone)]
struct HttpRequestBodyStream {
    receiver: Arc<Mutex<mpsc::Receiver<HttpRequestBodyEvent>>>,
}

struct HttpRequestBodyProducer {
    cancellation: CancellationSource,
    handle: thread::JoinHandle<()>,
}

impl fmt::Debug for HttpRequestBodyStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpRequestBodyStream")
            .finish_non_exhaustive()
    }
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

impl GatewayHttpRequestBodyReader {
    fn new(request: &HttpBridgeRequest) -> Self {
        let buffered = (!request.request.body.is_empty()).then(|| request.request.body.clone());
        let stream_request = request.has_streaming_body().then(|| request.clone());
        Self {
            buffered,
            stream_request,
        }
    }

    pub fn read_chunk_blocking(&mut self) -> std::result::Result<Option<Vec<u8>>, HttpBridgeError> {
        if let Some(chunk) = self.buffered.take() {
            return Ok(Some(chunk));
        }
        let Some(request) = &self.stream_request else {
            return Ok(None);
        };
        request.read_streaming_body_chunk_blocking()
    }

    pub fn read_to_end_blocking(&mut self) -> std::result::Result<Vec<u8>, HttpBridgeError> {
        let mut body = Vec::new();
        while let Some(chunk) = self.read_chunk_blocking()? {
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }

    fn is_streaming(&self) -> bool {
        self.stream_request.is_some()
    }
}

impl GatewayHttpResponseWriter {
    fn new(request: HttpBridgeRequest) -> Self {
        Self { request }
    }

    pub fn write_body_chunk(&self, chunk: Vec<u8>) -> std::result::Result<(), HttpBridgeError> {
        self.request.write_body_chunk(chunk)
    }

    pub async fn write_body_chunk_async(
        &self,
        chunk: Vec<u8>,
    ) -> std::result::Result<(), HttpBridgeError> {
        self.request.write_body_chunk_async(chunk).await
    }

    pub fn finish(
        &self,
        status: u16,
        headers: Vec<HttpHeader>,
        body: Vec<u8>,
    ) -> std::result::Result<(), HttpBridgeError> {
        self.request
            .respond(HttpResponse::new(status, headers, body)?)
    }

    pub async fn finish_async(
        &self,
        status: u16,
        headers: Vec<HttpHeader>,
        body: Vec<u8>,
    ) -> std::result::Result<(), HttpBridgeError> {
        self.request
            .respond_async(HttpResponse::new(status, headers, body)?)
            .await
    }

    pub fn respond(
        &self,
        response: GatewayHttpResponse,
    ) -> std::result::Result<(), HttpBridgeError> {
        let GatewayHttpResponse {
            status,
            headers,
            body,
        } = response;
        match body {
            GatewayHttpResponseBody::Complete(body) => self.finish(status, headers, body),
            GatewayHttpResponseBody::Chunks(chunks) => {
                for chunk in chunks {
                    self.write_body_chunk(chunk)?;
                }
                self.finish(status, headers, Vec::new())
            }
        }
    }

    pub async fn respond_async(
        &self,
        response: GatewayHttpResponse,
    ) -> std::result::Result<(), HttpBridgeError> {
        let GatewayHttpResponse {
            status,
            headers,
            body,
        } = response;
        match body {
            GatewayHttpResponseBody::Complete(body) => {
                self.finish_async(status, headers, body).await
            }
            GatewayHttpResponseBody::Chunks(chunks) => {
                for chunk in chunks {
                    self.write_body_chunk_async(chunk).await?;
                }
                self.finish_async(status, headers, Vec::new()).await
            }
        }
    }
}

impl GatewayHttpResponse {
    pub fn complete(
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
            body: GatewayHttpResponseBody::Complete(body),
        })
    }

    pub fn chunks(
        status: u16,
        headers: Vec<HttpHeader>,
        chunks: Vec<Vec<u8>>,
    ) -> std::result::Result<Self, HttpBridgeError> {
        if !(100..=599).contains(&status) {
            return Err(HttpBridgeError::invalid_response(format!(
                "HTTP response status must be between 100 and 599, got {status}"
            )));
        }
        Ok(Self {
            status,
            headers,
            body: GatewayHttpResponseBody::Chunks(chunks),
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl NativeGatewayHttpTransport {
    pub fn new(endpoint: impl Into<String>) -> std::result::Result<Self, HttpBridgeError> {
        let endpoint = normalize_http_url(endpoint.into())?;
        let _ = parse_native_http_url(&endpoint)?;
        let (bridge, receiver) = HttpBridge::new(HTTP_GATEWAY_EVENT_QUEUE_SIZE);
        let worker = NativeHttpBridgeWorker::spawn(receiver);
        Ok(Self {
            endpoint,
            bridge,
            _worker: Arc::new(Mutex::new(worker)),
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl GatewayHttpTransport for NativeGatewayHttpTransport {
    fn dispatch(
        &self,
        request: GatewayHttpRequest,
        cancellation: CancellationToken,
    ) -> std::result::Result<GatewayHttpResponse, HttpBridgeError> {
        if request.body.is_streaming() {
            return self.dispatch_streaming_request(request, cancellation);
        }

        let wire_request = encode_gateway_wire_request(request)?;
        let body = serde_json::to_vec(&wire_request).map_err(|error| {
            HttpBridgeError::invalid_request(format!(
                "unable to encode HTTP gateway request: {error}"
            ))
        })?;
        let response = self
            .bridge
            .request_blocking(
                HttpRequest::new(
                    "POST",
                    self.endpoint.clone(),
                    vec![
                        HttpHeader::new("content-type", "application/json")?,
                        HttpHeader::new("accept", "application/json")?,
                    ],
                    body,
                )?,
                HttpRequestLimits {
                    response_body_bytes: HTTP_GATEWAY_RESPONSE_BODY_LIMIT,
                    wall_time: None,
                },
                cancellation,
            )
            .map_err(map_gateway_endpoint_error)?;

        decode_gateway_endpoint_response(response)
    }

    fn dispatch_with_response_writer(
        &self,
        request: GatewayHttpRequest,
        response: GatewayHttpResponseWriter,
        cancellation: CancellationToken,
    ) -> std::result::Result<(), HttpBridgeError> {
        dispatch_gateway_endpoint_request(&self.endpoint, request, response, cancellation)
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl NativeGatewayHttpTransport {
    fn dispatch_streaming_request(
        &self,
        request: GatewayHttpRequest,
        cancellation: CancellationToken,
    ) -> std::result::Result<GatewayHttpResponse, HttpBridgeError> {
        let endpoint = self.endpoint.clone();
        let response = self
            .bridge
            .request_streaming_blocking(
                HttpRequest::new(
                    "POST",
                    endpoint,
                    vec![
                        HttpHeader::new("content-type", "application/x-ndjson")?,
                        HttpHeader::new("accept", "application/json")?,
                    ],
                    Vec::new(),
                )?,
                HttpRequestLimits {
                    response_body_bytes: HTTP_GATEWAY_RESPONSE_BODY_LIMIT,
                    wall_time: None,
                },
                cancellation,
                move |body| write_gateway_streaming_request_body(body, request),
            )
            .map_err(map_gateway_endpoint_error)?;

        decode_gateway_endpoint_response(response)
    }
}

fn encode_gateway_wire_request(
    mut request: GatewayHttpRequest,
) -> std::result::Result<GatewayWireRequest, HttpBridgeError> {
    let mut body_chunks_base64 = Vec::new();
    while let Some(chunk) = request.body.read_chunk_blocking()? {
        body_chunks_base64.push(BASE64.encode(chunk));
    }

    Ok(GatewayWireRequest {
        schema: 1,
        id: request.id,
        method: request.method,
        url: request.url,
        headers: request
            .headers
            .into_iter()
            .map(|header| GatewayWireHeader {
                name: header.name,
                value: header.value,
            })
            .collect(),
        body_chunks_base64,
    })
}

fn write_gateway_streaming_request_body(
    body: &mut HttpRequestBodyWriter,
    mut request: GatewayHttpRequest,
) -> std::result::Result<(), HttpBridgeError> {
    write_gateway_stream_frame(
        body,
        &GatewayStreamWireRequestFrame::Request {
            schema: 1,
            id: request.id,
            method: request.method,
            url: request.url,
            headers: request
                .headers
                .into_iter()
                .map(|header| GatewayWireHeader {
                    name: header.name,
                    value: header.value,
                })
                .collect(),
        },
    )?;
    while let Some(chunk) = request.body.read_chunk_blocking()? {
        write_gateway_stream_frame(
            body,
            &GatewayStreamWireRequestFrame::BodyChunk {
                body_base64: BASE64.encode(chunk),
            },
        )?;
    }
    write_gateway_stream_frame(body, &GatewayStreamWireRequestFrame::BodyEnd)
}

fn write_gateway_stream_frame(
    body: &mut HttpRequestBodyWriter,
    frame: &GatewayStreamWireRequestFrame,
) -> std::result::Result<(), HttpBridgeError> {
    let mut data = serde_json::to_vec(frame).map_err(|error| {
        HttpBridgeError::invalid_request(format!("unable to encode HTTP gateway frame: {error}"))
    })?;
    data.push(b'\n');
    body.write_chunk_blocking(data)
}

#[cfg(not(target_arch = "wasm32"))]
fn dispatch_gateway_endpoint_request(
    endpoint: &str,
    request: GatewayHttpRequest,
    response: GatewayHttpResponseWriter,
    cancellation: CancellationToken,
) -> std::result::Result<(), HttpBridgeError> {
    let url = parse_native_http_url(endpoint)?;
    let mut stream = connect_native_http(&url, cancellation.clone())?;
    stream
        .set_read_timeout(Some(NATIVE_HTTP_IO_TIMEOUT))
        .map_err(|error| {
            HttpBridgeError::transport(format!("unable to set read timeout: {error}"))
        })?;
    stream
        .set_write_timeout(Some(NATIVE_HTTP_IO_TIMEOUT))
        .map_err(|error| {
            HttpBridgeError::transport(format!("unable to set write timeout: {error}"))
        })?;

    write_gateway_endpoint_request(&mut stream, &url, request, cancellation.clone())?;
    let head = read_native_http_response_head(&mut stream, &cancellation)?;
    validate_gateway_endpoint_status(head.status)?;
    if is_gateway_stream_response(&head.headers) {
        let mut decoder = GatewayStreamResponseDecoder::new(response);
        read_native_http_response_body_chunks(
            &mut stream,
            &cancellation,
            head,
            Some(HTTP_GATEWAY_RESPONSE_BODY_LIMIT),
            |chunk| decoder.push(chunk),
        )?;
        decoder.finish()
    } else {
        let status = head.status;
        let headers = head.headers.clone();
        let mut body = Vec::new();
        read_native_http_response_body_chunks(
            &mut stream,
            &cancellation,
            head,
            Some(HTTP_GATEWAY_RESPONSE_BODY_LIMIT),
            |chunk| append_response_body(&mut body, chunk, HTTP_GATEWAY_RESPONSE_BODY_LIMIT),
        )?;
        response.respond(decode_gateway_endpoint_response(HttpResponse::new(
            status, headers, body,
        )?)?)
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn write_gateway_endpoint_request(
    stream: &mut TcpStream,
    url: &NativeHttpUrl,
    request: GatewayHttpRequest,
    cancellation: CancellationToken,
) -> std::result::Result<(), HttpBridgeError> {
    write_http_line(
        stream,
        format_args!("POST {} HTTP/1.1\r\n", url.request_target),
    )?;
    write_http_line(stream, format_args!("Host: {}\r\n", url.authority))?;
    write_http_line(
        stream,
        format_args!("Accept: application/json, application/x-ndjson\r\n"),
    )?;
    write_http_line(stream, format_args!("Connection: close\r\n"))?;

    if request.body.is_streaming() {
        write_http_line(
            stream,
            format_args!("Content-Type: application/x-ndjson\r\n"),
        )?;
        write_http_line(stream, format_args!("Transfer-Encoding: chunked\r\n\r\n"))?;
        write_gateway_streaming_request_body_to_http(stream, request, cancellation)
    } else {
        let wire_request = encode_gateway_wire_request(request)?;
        let body = serde_json::to_vec(&wire_request).map_err(|error| {
            HttpBridgeError::invalid_request(format!(
                "unable to encode HTTP gateway request: {error}"
            ))
        })?;
        write_http_line(stream, format_args!("Content-Type: application/json\r\n"))?;
        write_http_line(
            stream,
            format_args!("Content-Length: {}\r\n\r\n", body.len()),
        )?;
        stream.write_all(&body).map_err(|error| {
            HttpBridgeError::transport(format!("unable to write HTTP gateway request: {error}"))
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn write_gateway_streaming_request_body_to_http(
    stream: &mut TcpStream,
    mut request: GatewayHttpRequest,
    cancellation: CancellationToken,
) -> std::result::Result<(), HttpBridgeError> {
    write_gateway_stream_frame_to_http(
        stream,
        &GatewayStreamWireRequestFrame::Request {
            schema: 1,
            id: request.id,
            method: request.method,
            url: request.url,
            headers: request
                .headers
                .into_iter()
                .map(|header| GatewayWireHeader {
                    name: header.name,
                    value: header.value,
                })
                .collect(),
        },
        &cancellation,
    )?;
    while let Some(chunk) = request.body.read_chunk_blocking()? {
        write_gateway_stream_frame_to_http(
            stream,
            &GatewayStreamWireRequestFrame::BodyChunk {
                body_base64: BASE64.encode(chunk),
            },
            &cancellation,
        )?;
    }
    write_gateway_stream_frame_to_http(
        stream,
        &GatewayStreamWireRequestFrame::BodyEnd,
        &cancellation,
    )?;
    write_http_line(stream, format_args!("0\r\n\r\n"))
}

#[cfg(not(target_arch = "wasm32"))]
fn write_gateway_stream_frame_to_http(
    stream: &mut TcpStream,
    frame: &GatewayStreamWireRequestFrame,
    cancellation: &CancellationToken,
) -> std::result::Result<(), HttpBridgeError> {
    if cancellation.is_cancelled() {
        return Err(HttpBridgeError::cancelled("HTTP request cancelled"));
    }
    let mut data = serde_json::to_vec(frame).map_err(|error| {
        HttpBridgeError::invalid_request(format!("unable to encode HTTP gateway frame: {error}"))
    })?;
    data.push(b'\n');
    write_http_line(stream, format_args!("{:x}\r\n", data.len()))?;
    stream.write_all(&data).map_err(|error| {
        HttpBridgeError::transport(format!("unable to write HTTP gateway request: {error}"))
    })?;
    write_http_line(stream, format_args!("\r\n"))
}

fn decode_gateway_endpoint_response(
    response: HttpResponse,
) -> std::result::Result<GatewayHttpResponse, HttpBridgeError> {
    validate_gateway_endpoint_status(response.status)?;

    let wire_response: GatewayWireResponse =
        serde_json::from_slice(&response.body).map_err(|error| {
            HttpBridgeError::invalid_response(format!(
                "invalid HTTP gateway response JSON: {error}"
            ))
        })?;
    decode_gateway_wire_response(wire_response)
}

fn validate_gateway_endpoint_status(status: u16) -> std::result::Result<(), HttpBridgeError> {
    match status {
        200..=299 => {}
        401 | 403 => {
            return Err(HttpBridgeError::auth_failure(
                "HTTP gateway authentication failed",
            ))
        }
        404 | 502 | 503 | 504 => {
            return Err(HttpBridgeError::gateway_unavailable(
                "HTTP gateway endpoint is unavailable",
            ))
        }
        status => {
            return Err(HttpBridgeError::transport(format!(
                "HTTP gateway returned status {status}"
            )))
        }
    }
    Ok(())
}

impl GatewayStreamResponseDecoder {
    fn new(writer: GatewayHttpResponseWriter) -> Self {
        Self {
            writer,
            buffer: Vec::new(),
            response: None,
            completed: false,
        }
    }

    fn push(&mut self, chunk: Vec<u8>) -> std::result::Result<(), HttpBridgeError> {
        self.buffer.extend_from_slice(&chunk);
        if self.buffer.len() > HTTP_GATEWAY_RESPONSE_BODY_LIMIT {
            return Err(HttpBridgeError::response_too_large(
                "HTTP gateway stream frame exceeded bridge limit",
            ));
        }
        while let Some(index) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line = self.buffer.drain(..=index).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            let frame: GatewayStreamWireResponseFrame =
                serde_json::from_slice(&line).map_err(|error| {
                    HttpBridgeError::invalid_response(format!(
                        "invalid HTTP gateway stream frame: {error}"
                    ))
                })?;
            self.apply(frame)?;
        }
        Ok(())
    }

    fn apply(
        &mut self,
        frame: GatewayStreamWireResponseFrame,
    ) -> std::result::Result<(), HttpBridgeError> {
        if self.completed {
            return Err(HttpBridgeError::invalid_response(
                "HTTP gateway stream sent a frame after body_end",
            ));
        }

        match frame {
            GatewayStreamWireResponseFrame::Response { status, headers } => {
                if self.response.is_some() {
                    return Err(HttpBridgeError::invalid_response(
                        "HTTP gateway stream sent multiple response frames",
                    ));
                }
                let headers = headers
                    .into_iter()
                    .map(|header| HttpHeader::new(header.name, header.value))
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                self.response = Some((status, headers));
                Ok(())
            }
            GatewayStreamWireResponseFrame::BodyChunk { body_base64 } => {
                if self.response.is_none() {
                    return Err(HttpBridgeError::invalid_response(
                        "HTTP gateway stream body_chunk arrived before response",
                    ));
                }
                self.writer
                    .write_body_chunk(decode_gateway_body(&body_base64)?)
            }
            GatewayStreamWireResponseFrame::BodyEnd => {
                if self.response.is_none() {
                    return Err(HttpBridgeError::invalid_response(
                        "HTTP gateway stream body_end arrived before response",
                    ));
                }
                self.completed = true;
                Ok(())
            }
            GatewayStreamWireResponseFrame::Error { kind, message } => {
                Err(decode_gateway_wire_error(GatewayWireError {
                    kind,
                    message,
                })?)
            }
        }
    }

    fn finish(mut self) -> std::result::Result<(), HttpBridgeError> {
        if self.buffer.iter().any(|byte| !byte.is_ascii_whitespace()) {
            return Err(HttpBridgeError::invalid_response(
                "HTTP gateway stream ended with a partial frame",
            ));
        }
        if !self.completed {
            return Err(HttpBridgeError::invalid_response(
                "HTTP gateway stream did not send body_end",
            ));
        }
        let Some((status, headers)) = self.response.take() else {
            return Err(HttpBridgeError::invalid_response(
                "HTTP gateway stream body_end arrived before response",
            ));
        };
        self.writer.finish(status, headers, Vec::new())
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn is_gateway_stream_response(headers: &[HttpHeader]) -> bool {
    native_http_header_value(headers, "content-type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .eq_ignore_ascii_case("application/x-ndjson")
    })
}

fn decode_gateway_wire_response(
    wire_response: GatewayWireResponse,
) -> std::result::Result<GatewayHttpResponse, HttpBridgeError> {
    if !wire_response.ok {
        let error = wire_response.error.ok_or_else(|| {
            HttpBridgeError::invalid_response("HTTP gateway error response is missing error")
        })?;
        return Err(decode_gateway_wire_error(error)?);
    }

    let response = wire_response.response.ok_or_else(|| {
        HttpBridgeError::invalid_response("HTTP gateway success response is missing response")
    })?;
    let headers = response
        .headers
        .into_iter()
        .map(|header| HttpHeader::new(header.name, header.value))
        .collect::<std::result::Result<Vec<_>, _>>()?;

    match (response.body_base64, response.body_chunks_base64) {
        (Some(_), Some(_)) => Err(HttpBridgeError::invalid_response(
            "HTTP gateway response cannot include both body_base64 and body_chunks_base64",
        )),
        (Some(body), None) => {
            GatewayHttpResponse::complete(response.status, headers, decode_gateway_body(&body)?)
        }
        (None, Some(chunks)) => {
            let chunks = chunks
                .into_iter()
                .map(|chunk| decode_gateway_body(&chunk))
                .collect::<std::result::Result<Vec<_>, _>>()?;
            GatewayHttpResponse::chunks(response.status, headers, chunks)
        }
        (None, None) => GatewayHttpResponse::complete(response.status, headers, Vec::new()),
    }
}

fn decode_gateway_body(value: &str) -> std::result::Result<Vec<u8>, HttpBridgeError> {
    BASE64.decode(value).map_err(|error| {
        HttpBridgeError::invalid_response(format!("invalid gateway body base64: {error}"))
    })
}

fn decode_gateway_wire_error(
    error: GatewayWireError,
) -> std::result::Result<HttpBridgeError, HttpBridgeError> {
    let message = error.message;
    match error.kind.as_str() {
        "invalid_request" => Ok(HttpBridgeError::invalid_request(message)),
        "invalid_response" => Ok(HttpBridgeError::invalid_response(message)),
        "unsupported_scheme" => Ok(HttpBridgeError::unsupported_scheme(message)),
        "gateway_unavailable" => Ok(HttpBridgeError::gateway_unavailable(message)),
        "auth_failure" => Ok(HttpBridgeError::auth_failure(message)),
        "cors" => Ok(HttpBridgeError::cors(message)),
        "timeout" => Ok(HttpBridgeError::timeout(message)),
        "cancelled" => Ok(HttpBridgeError::cancelled(message)),
        "transport" => Ok(HttpBridgeError::transport(message)),
        "response_too_large" => Ok(HttpBridgeError::response_too_large(message)),
        kind => Err(HttpBridgeError::invalid_response(format!(
            "unknown HTTP gateway error kind: {kind}"
        ))),
    }
}

fn map_gateway_endpoint_error(error: HttpBridgeError) -> HttpBridgeError {
    match error.kind {
        HttpBridgeErrorKind::InvalidRequest => {
            HttpBridgeError::invalid_request("invalid HTTP gateway endpoint request")
        }
        HttpBridgeErrorKind::InvalidResponse => {
            HttpBridgeError::invalid_response("invalid HTTP gateway endpoint response")
        }
        HttpBridgeErrorKind::UnsupportedScheme => {
            HttpBridgeError::unsupported_scheme("HTTP gateway endpoint uses an unsupported scheme")
        }
        HttpBridgeErrorKind::GatewayUnavailable => {
            HttpBridgeError::gateway_unavailable("HTTP gateway endpoint is unavailable")
        }
        HttpBridgeErrorKind::AuthFailure => {
            HttpBridgeError::auth_failure("HTTP gateway authentication failed")
        }
        HttpBridgeErrorKind::Cors => {
            HttpBridgeError::cors("HTTP gateway endpoint blocked the request")
        }
        HttpBridgeErrorKind::Timeout => HttpBridgeError::timeout("HTTP gateway request timed out"),
        HttpBridgeErrorKind::Cancelled => {
            HttpBridgeError::cancelled("HTTP gateway request cancelled")
        }
        HttpBridgeErrorKind::Transport => {
            HttpBridgeError::transport("HTTP gateway endpoint transport failed")
        }
        HttpBridgeErrorKind::ResponseTooLarge => {
            HttpBridgeError::response_too_large("HTTP gateway response exceeded bridge limit")
        }
    }
}

impl HttpRequestBodyWriter {
    pub fn write_chunk_blocking(
        &mut self,
        chunk: Vec<u8>,
    ) -> std::result::Result<(), HttpBridgeError> {
        if chunk.is_empty() {
            return Ok(());
        }
        self.send_event_blocking(HttpRequestBodyEvent::Chunk(chunk))
    }

    pub fn finish(&mut self) -> std::result::Result<(), HttpBridgeError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        self.send_event_blocking(HttpRequestBodyEvent::Complete(Ok(())))
    }

    pub fn fail(&mut self, error: HttpBridgeError) -> std::result::Result<(), HttpBridgeError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        self.send_event_blocking(HttpRequestBodyEvent::Complete(Err(error)))
    }

    fn send_event_blocking(
        &mut self,
        mut event: HttpRequestBodyEvent,
    ) -> std::result::Result<(), HttpBridgeError> {
        loop {
            if self.cancellation.is_cancelled() {
                return Err(HttpBridgeError::cancelled("HTTP request cancelled"));
            }
            match self.sender.try_send(event) {
                Ok(()) => return Ok(()),
                Err(mpsc::TrySendError::Full(returned)) => {
                    event = returned;
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    return Err(HttpBridgeError::transport(
                        "HTTP request body receiver closed",
                    ))
                }
            }
        }
    }
}

impl HttpRequestBodyStream {
    fn new(capacity: usize) -> (Self, mpsc::SyncSender<HttpRequestBodyEvent>) {
        let (sender, receiver) = mpsc::sync_channel(capacity);
        (
            Self {
                receiver: Arc::new(Mutex::new(receiver)),
            },
            sender,
        )
    }

    fn read_chunk_blocking(
        &self,
        cancellation: &CancellationToken,
    ) -> std::result::Result<Option<Vec<u8>>, HttpBridgeError> {
        loop {
            if cancellation.is_cancelled() {
                return Err(HttpBridgeError::cancelled("HTTP request cancelled"));
            }
            let result = self
                .receiver
                .lock()
                .map_err(|_| HttpBridgeError::transport("HTTP request body receiver poisoned"))?
                .recv_timeout(Duration::from_millis(10));
            match result {
                Ok(HttpRequestBodyEvent::Chunk(chunk)) => return Ok(Some(chunk)),
                Ok(HttpRequestBodyEvent::Complete(Ok(()))) => return Ok(None),
                Ok(HttpRequestBodyEvent::Complete(Err(error))) => return Err(error),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(HttpBridgeError::transport(
                        "HTTP request body sender closed",
                    ))
                }
            }
        }
    }
}

impl HttpBridgeRequest {
    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn has_streaming_body(&self) -> bool {
        self.body_stream.is_some()
    }

    pub fn read_streaming_body_chunk_blocking(
        &self,
    ) -> std::result::Result<Option<Vec<u8>>, HttpBridgeError> {
        let Some(stream) = &self.body_stream else {
            return Ok(None);
        };
        stream.read_chunk_blocking(&self.cancellation)
    }

    pub fn respond(&self, response: HttpResponse) -> std::result::Result<(), HttpBridgeError> {
        self.send_response_event_blocking(HttpBridgeResponseEvent::Complete(Ok(response)))
    }

    pub async fn respond_async(
        &self,
        response: HttpResponse,
    ) -> std::result::Result<(), HttpBridgeError> {
        self.send_response_event_async(HttpBridgeResponseEvent::Complete(Ok(response)))
            .await
    }

    pub fn fail(&self, error: HttpBridgeError) -> std::result::Result<(), HttpBridgeError> {
        self.send_response_event_blocking(HttpBridgeResponseEvent::Complete(Err(error)))
    }

    pub async fn fail_async(
        &self,
        error: HttpBridgeError,
    ) -> std::result::Result<(), HttpBridgeError> {
        self.send_response_event_async(HttpBridgeResponseEvent::Complete(Err(error)))
            .await
    }

    pub fn write_body_chunk(&self, chunk: Vec<u8>) -> std::result::Result<(), HttpBridgeError> {
        self.send_response_event_blocking(HttpBridgeResponseEvent::Body(chunk))
    }

    pub async fn write_body_chunk_async(
        &self,
        chunk: Vec<u8>,
    ) -> std::result::Result<(), HttpBridgeError> {
        self.send_response_event_async(HttpBridgeResponseEvent::Body(chunk))
            .await
    }

    fn send_response_event_blocking(
        &self,
        mut event: HttpBridgeResponseEvent,
    ) -> std::result::Result<(), HttpBridgeError> {
        loop {
            if self.cancellation.is_cancelled() {
                return Err(HttpBridgeError::cancelled("HTTP request cancelled"));
            }
            match self.response_sender.try_send(event) {
                Ok(()) => return Ok(()),
                Err(tokio::sync::mpsc::error::TrySendError::Full(returned)) => {
                    event = returned;
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    return Err(HttpBridgeError::transport("HTTP response receiver closed"))
                }
            }
        }
    }

    async fn send_response_event_async(
        &self,
        event: HttpBridgeResponseEvent,
    ) -> std::result::Result<(), HttpBridgeError> {
        if self.cancellation.is_cancelled() {
            return Err(HttpBridgeError::cancelled("HTTP request cancelled"));
        }
        self.response_sender
            .send(event)
            .await
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

    pub async fn request_async(
        &self,
        request: HttpRequest,
        limits: HttpRequestLimits,
        cancellation: CancellationToken,
    ) -> std::result::Result<HttpResponse, HttpBridgeError> {
        self.request_async_with_stream(request, None, limits, cancellation)
            .await
    }

    pub fn request_blocking(
        &self,
        request: HttpRequest,
        limits: HttpRequestLimits,
        cancellation: CancellationToken,
    ) -> std::result::Result<HttpResponse, HttpBridgeError> {
        self.request_blocking_with_stream(request, None, limits, cancellation)
    }

    pub fn request_streaming_blocking<Producer>(
        &self,
        request: HttpRequest,
        limits: HttpRequestLimits,
        cancellation: CancellationToken,
        producer: Producer,
    ) -> std::result::Result<HttpResponse, HttpBridgeError>
    where
        Producer: FnOnce(&mut HttpRequestBodyWriter) -> std::result::Result<(), HttpBridgeError>
            + Send
            + 'static,
    {
        if !request.body.is_empty() {
            return Err(HttpBridgeError::invalid_request(
                "streaming HTTP requests cannot include a buffered request body",
            ));
        }

        let producer_cancellation = CancellationSource::new();
        let (body_stream, body_sender) =
            HttpRequestBodyStream::new(HTTP_REQUEST_BODY_EVENT_QUEUE_SIZE);
        let writer = HttpRequestBodyWriter {
            sender: body_sender,
            cancellation: producer_cancellation.token(),
            closed: false,
        };
        let handle = thread::spawn(move || {
            let mut writer = writer;
            match producer(&mut writer) {
                Ok(()) => {
                    let _ = writer.finish();
                }
                Err(error) => {
                    let _ = writer.fail(error);
                }
            }
        });
        let body_producer = HttpRequestBodyProducer {
            cancellation: producer_cancellation,
            handle,
        };
        self.request_blocking_with_body_producer(
            request,
            Some(body_stream),
            limits,
            cancellation,
            Some(body_producer),
        )
    }

    fn request_blocking_with_stream(
        &self,
        request: HttpRequest,
        body_stream: Option<HttpRequestBodyStream>,
        limits: HttpRequestLimits,
        cancellation: CancellationToken,
    ) -> std::result::Result<HttpResponse, HttpBridgeError> {
        self.request_blocking_with_body_producer(request, body_stream, limits, cancellation, None)
    }

    fn request_blocking_with_body_producer(
        &self,
        request: HttpRequest,
        body_stream: Option<HttpRequestBodyStream>,
        limits: HttpRequestLimits,
        cancellation: CancellationToken,
        body_producer: Option<HttpRequestBodyProducer>,
    ) -> std::result::Result<HttpResponse, HttpBridgeError> {
        let result = self.request_blocking_inner(request, body_stream, limits, cancellation);
        if let Some(producer) = body_producer {
            producer.cancellation.cancel();
            let _ = producer.handle.join();
        }
        result
    }

    fn request_blocking_inner(
        &self,
        request: HttpRequest,
        body_stream: Option<HttpRequestBodyStream>,
        limits: HttpRequestLimits,
        cancellation: CancellationToken,
    ) -> std::result::Result<HttpResponse, HttpBridgeError> {
        let id = self.inner.sequence.fetch_add(1, Ordering::AcqRel) + 1;
        let (response_sender, mut response_receiver) =
            tokio::sync::mpsc::channel(HTTP_RESPONSE_EVENT_QUEUE_SIZE);
        let request_cancellation = CancellationSource::new();
        let mut pending = Some(HttpBridgeRequest {
            id,
            request,
            cancellation: request_cancellation.token(),
            response_sender,
            body_stream,
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
            match response_receiver.try_recv() {
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
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                    std::thread::sleep(wait_time);
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    request_cancellation.cancel();
                    return Err(HttpBridgeError::transport("HTTP response channel closed"));
                }
            }
        }
    }

    async fn request_async_with_stream(
        &self,
        request: HttpRequest,
        body_stream: Option<HttpRequestBodyStream>,
        limits: HttpRequestLimits,
        cancellation: CancellationToken,
    ) -> std::result::Result<HttpResponse, HttpBridgeError> {
        let id = self.inner.sequence.fetch_add(1, Ordering::AcqRel) + 1;
        let (response_sender, mut response_receiver) =
            tokio::sync::mpsc::channel(HTTP_RESPONSE_EVENT_QUEUE_SIZE);
        let request_cancellation = CancellationSource::new();
        let mut pending = Some(HttpBridgeRequest {
            id,
            request,
            cancellation: request_cancellation.token(),
            response_sender,
            body_stream,
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
                    tokio::time::sleep(Duration::from_millis(1)).await;
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
            match response_receiver.try_recv() {
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
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                    tokio::time::sleep(wait_time).await;
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    request_cancellation.cancel();
                    return Err(HttpBridgeError::transport("HTTP response channel closed"));
                }
            }
        }
    }
}

impl GatewayHttpBridgeWorker {
    pub fn spawn<T>(
        mut receiver: tokio::sync::mpsc::Receiver<HttpBridgeRequest>,
        transport: T,
    ) -> Self
    where
        T: GatewayHttpTransport,
    {
        let transport = Arc::new(transport);
        Self {
            _handle: thread::spawn(move || {
                while let Some(request) = receiver.blocking_recv() {
                    if request.cancellation_token().is_cancelled() {
                        continue;
                    }
                    let transport = Arc::clone(&transport);
                    if let Err(error) = dispatch_gateway_http_request(&request, transport.as_ref())
                    {
                        let _ = request.fail(error);
                    }
                }
            }),
        }
    }
}

pub async fn run_async_http_bridge_worker<T>(
    mut receiver: tokio::sync::mpsc::Receiver<HttpBridgeRequest>,
    transport: T,
) where
    T: AsyncHttpBridgeTransport,
{
    while let Some(request) = receiver.recv().await {
        if request.cancellation_token().is_cancelled() {
            continue;
        }
        if let Err(error) = dispatch_async_http_bridge_request(&request, &transport).await {
            let _ = request.fail_async(error).await;
        }
    }
}

async fn dispatch_async_http_bridge_request<T>(
    request: &HttpBridgeRequest,
    transport: &T,
) -> std::result::Result<(), HttpBridgeError>
where
    T: AsyncHttpBridgeTransport,
{
    transport
        .dispatch(
            GatewayHttpRequest {
                id: request.id,
                method: request.request.method.clone(),
                url: request.request.url.clone(),
                headers: request.request.headers.clone(),
                body: GatewayHttpRequestBodyReader::new(request),
            },
            GatewayHttpResponseWriter::new(request.clone()),
            request.cancellation_token(),
        )
        .await
}

fn dispatch_gateway_http_request(
    request: &HttpBridgeRequest,
    transport: &dyn GatewayHttpTransport,
) -> std::result::Result<(), HttpBridgeError> {
    transport.dispatch_with_response_writer(
        GatewayHttpRequest {
            id: request.id,
            method: request.request.method.clone(),
            url: request.request.url.clone(),
            headers: request.request.headers.clone(),
            body: GatewayHttpRequestBodyReader::new(request),
        },
        GatewayHttpResponseWriter::new(request.clone()),
        request.cancellation_token(),
    )
}

#[cfg(not(target_arch = "wasm32"))]
impl NativeHttpBridgeWorker {
    pub fn spawn(mut receiver: tokio::sync::mpsc::Receiver<HttpBridgeRequest>) -> Self {
        Self {
            _handle: thread::spawn(move || {
                while let Some(request) = receiver.blocking_recv() {
                    if request.cancellation_token().is_cancelled() {
                        continue;
                    }
                    if let Err(error) = dispatch_native_http_request(&request) {
                        let _ = request.fail(error);
                    }
                }
            }),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug)]
struct NativeHttpUrl {
    host: String,
    port: u16,
    authority: String,
    request_target: String,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug)]
struct NativeHttpResponseHead {
    status: u16,
    headers: Vec<HttpHeader>,
    content_length: Option<usize>,
    chunked: bool,
    body_prefix: Vec<u8>,
}

#[cfg(not(target_arch = "wasm32"))]
fn dispatch_native_http_request(
    request: &HttpBridgeRequest,
) -> std::result::Result<(), HttpBridgeError> {
    let mut current = request.request.clone();
    for redirect_count in 0..=NATIVE_HTTP_MAX_REDIRECTS {
        if request.cancellation_token().is_cancelled() {
            return Err(HttpBridgeError::cancelled("HTTP request cancelled"));
        }

        let cancellation = request.cancellation_token();
        let url = parse_native_http_url(&current.url)?;
        let mut stream = connect_native_http(&url, cancellation.clone())?;
        stream
            .set_read_timeout(Some(NATIVE_HTTP_IO_TIMEOUT))
            .map_err(|error| {
                HttpBridgeError::transport(format!("unable to set read timeout: {error}"))
            })?;
        stream
            .set_write_timeout(Some(NATIVE_HTTP_IO_TIMEOUT))
            .map_err(|error| {
                HttpBridgeError::transport(format!("unable to set write timeout: {error}"))
            })?;

        write_native_http_request(&mut stream, request, &current, &url)?;
        let head = read_native_http_response_head(&mut stream, &cancellation)?;
        if let Some(redirected) =
            native_http_redirect_request(&current, &url, &head, redirect_count)?
        {
            if request.has_streaming_body() {
                return Err(HttpBridgeError::invalid_response(
                    "HTTP redirects are not supported for streaming request bodies",
                ));
            }
            current = redirected;
            continue;
        }

        let response = read_native_http_response_body(&mut stream, request, head)?;
        return request.respond(response);
    }

    Err(HttpBridgeError::invalid_response(format!(
        "HTTP redirect limit exceeded: {NATIVE_HTTP_MAX_REDIRECTS}"
    )))
}

#[cfg(not(target_arch = "wasm32"))]
fn parse_native_http_url(url: &str) -> std::result::Result<NativeHttpUrl, HttpBridgeError> {
    let Some(rest) = url.strip_prefix("http://") else {
        let scheme = url.split_once(':').map_or("unknown", |(scheme, _)| scheme);
        return Err(HttpBridgeError::unsupported_scheme(format!(
            "native HTTP bridge supports http:// URLs only, got {scheme}"
        )));
    };
    let (authority, request_target) = split_native_http_authority_and_target(rest);
    if authority.is_empty() || authority.contains('@') {
        return Err(HttpBridgeError::invalid_request(
            "HTTP request URL must include a host without userinfo",
        ));
    }

    let (host, port) = parse_native_http_authority(authority)?;
    Ok(NativeHttpUrl {
        host,
        port,
        authority: authority.to_string(),
        request_target,
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn split_native_http_authority_and_target(rest: &str) -> (&str, String) {
    let authority_end = rest
        .find(|character| matches!(character, '/' | '?' | '#'))
        .unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let suffix = &rest[authority_end..];
    let target = suffix
        .split_once('#')
        .map_or(suffix, |(before_fragment, _)| before_fragment);
    let request_target = if target.is_empty() {
        "/".to_string()
    } else if target.starts_with('?') {
        format!("/{target}")
    } else {
        target.to_string()
    };
    (authority, request_target)
}

#[cfg(not(target_arch = "wasm32"))]
fn parse_native_http_authority(
    authority: &str,
) -> std::result::Result<(String, u16), HttpBridgeError> {
    if let Some(rest) = authority.strip_prefix('[') {
        let Some((host, suffix)) = rest.split_once(']') else {
            return Err(HttpBridgeError::invalid_request(
                "IPv6 HTTP URL host must include a closing bracket",
            ));
        };
        if host.is_empty() {
            return Err(HttpBridgeError::invalid_request(
                "HTTP request URL host cannot be empty",
            ));
        }
        let port = match suffix.strip_prefix(':') {
            Some(value) => parse_native_http_port(value)?,
            None if suffix.is_empty() => 80,
            _ => {
                return Err(HttpBridgeError::invalid_request(
                    "invalid IPv6 HTTP URL authority",
                ))
            }
        };
        return Ok((host.to_string(), port));
    }

    match authority.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => {
            if host.is_empty() {
                return Err(HttpBridgeError::invalid_request(
                    "HTTP request URL host cannot be empty",
                ));
            }
            Ok((host.to_string(), parse_native_http_port(port)?))
        }
        _ if authority.contains(':') => Err(HttpBridgeError::invalid_request(
            "IPv6 HTTP URL hosts must be bracketed",
        )),
        _ => Ok((authority.to_string(), 80)),
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn parse_native_http_port(value: &str) -> std::result::Result<u16, HttpBridgeError> {
    value
        .parse::<u16>()
        .map_err(|_| HttpBridgeError::invalid_request(format!("invalid HTTP URL port: {value}")))
}

#[cfg(not(target_arch = "wasm32"))]
fn connect_native_http(
    url: &NativeHttpUrl,
    cancellation: CancellationToken,
) -> std::result::Result<TcpStream, HttpBridgeError> {
    let addresses = (url.host.as_str(), url.port)
        .to_socket_addrs()
        .map_err(|error| {
            HttpBridgeError::transport(format!("unable to resolve HTTP host: {error}"))
        })?;
    let mut last_error = None;
    for address in addresses {
        if cancellation.is_cancelled() {
            return Err(HttpBridgeError::cancelled("HTTP request cancelled"));
        }
        match TcpStream::connect_timeout(&address, NATIVE_HTTP_CONNECT_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }
    Err(HttpBridgeError::gateway_unavailable(format!(
        "unable to connect to HTTP host {}:{}{}",
        url.host,
        url.port,
        last_error.map_or(String::new(), |error| format!(": {error}"))
    )))
}

#[cfg(not(target_arch = "wasm32"))]
fn write_native_http_request(
    stream: &mut TcpStream,
    bridge_request: &HttpBridgeRequest,
    request: &HttpRequest,
    url: &NativeHttpUrl,
) -> std::result::Result<(), HttpBridgeError> {
    write_http_line(
        stream,
        format_args!("{} {} HTTP/1.1\r\n", request.method, url.request_target),
    )?;
    if !request.headers.iter().any(|header| header.name == "host") {
        write_http_line(stream, format_args!("Host: {}\r\n", url.authority))?;
    }
    for header in &request.headers {
        if matches!(
            header.name.as_str(),
            "connection" | "content-length" | "transfer-encoding"
        ) {
            continue;
        }
        write_http_line(
            stream,
            format_args!("{}: {}\r\n", header.name, header.value),
        )?;
    }
    write_http_line(stream, format_args!("Connection: close\r\n"))?;
    if bridge_request.has_streaming_body() {
        write_http_line(stream, format_args!("Transfer-Encoding: chunked\r\n\r\n"))?;
        write_native_http_streaming_request_body(stream, bridge_request)
    } else {
        write_http_line(
            stream,
            format_args!("Content-Length: {}\r\n\r\n", request.body.len()),
        )?;
        stream.write_all(&request.body).map_err(|error| {
            HttpBridgeError::transport(format!("unable to write HTTP request body: {error}"))
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn write_native_http_streaming_request_body(
    stream: &mut TcpStream,
    request: &HttpBridgeRequest,
) -> std::result::Result<(), HttpBridgeError> {
    while let Some(chunk) = request.read_streaming_body_chunk_blocking()? {
        write_http_line(stream, format_args!("{:x}\r\n", chunk.len()))?;
        stream.write_all(&chunk).map_err(|error| {
            HttpBridgeError::transport(format!("unable to write HTTP request body: {error}"))
        })?;
        write_http_line(stream, format_args!("\r\n"))?;
    }
    write_http_line(stream, format_args!("0\r\n\r\n"))
}

#[cfg(not(target_arch = "wasm32"))]
fn write_http_line(
    stream: &mut TcpStream,
    args: fmt::Arguments<'_>,
) -> std::result::Result<(), HttpBridgeError> {
    stream.write_fmt(args).map_err(|error| {
        HttpBridgeError::transport(format!("unable to write HTTP request: {error}"))
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn read_native_http_response_head(
    stream: &mut TcpStream,
    cancellation: &CancellationToken,
) -> std::result::Result<NativeHttpResponseHead, HttpBridgeError> {
    let mut buffer = Vec::new();
    let header_end = loop {
        if cancellation.is_cancelled() {
            return Err(HttpBridgeError::cancelled("HTTP request cancelled"));
        }
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
        if buffer.len() > NATIVE_HTTP_HEADER_LIMIT {
            return Err(HttpBridgeError::invalid_response(format!(
                "HTTP response headers exceeded {NATIVE_HTTP_HEADER_LIMIT} bytes"
            )));
        }
        if read_more_native_http(stream, cancellation, &mut buffer, "HTTP response headers")? == 0 {
            return Err(HttpBridgeError::transport(
                "HTTP connection closed before response headers",
            ));
        }
    };

    let header_bytes = &buffer[..header_end];
    let body_start = header_end + 4;
    let body_prefix = buffer[body_start..].to_vec();
    let (status, headers, content_length, chunked) =
        parse_native_http_response_headers(header_bytes)?;
    Ok(NativeHttpResponseHead {
        status,
        headers,
        content_length,
        chunked,
        body_prefix,
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn read_native_http_response_body(
    stream: &mut TcpStream,
    request: &HttpBridgeRequest,
    head: NativeHttpResponseHead,
) -> std::result::Result<HttpResponse, HttpBridgeError> {
    let status = head.status;
    let headers = head.headers.clone();
    let cancellation = request.cancellation_token();
    read_native_http_response_body_chunks(stream, &cancellation, head, None, |chunk| {
        write_native_http_body_chunk(request, chunk)
    })?;

    HttpResponse::new(status, headers, Vec::new())
}

#[cfg(not(target_arch = "wasm32"))]
fn native_http_redirect_request(
    current: &HttpRequest,
    current_url: &NativeHttpUrl,
    head: &NativeHttpResponseHead,
    redirect_count: usize,
) -> std::result::Result<Option<HttpRequest>, HttpBridgeError> {
    if !is_native_http_redirect_status(head.status) {
        return Ok(None);
    }

    let Some(location) = native_http_header_value(&head.headers, "location") else {
        return Ok(None);
    };
    if redirect_count >= NATIVE_HTTP_MAX_REDIRECTS {
        return Err(HttpBridgeError::invalid_response(format!(
            "HTTP redirect limit exceeded: {NATIVE_HTTP_MAX_REDIRECTS}"
        )));
    }

    let redirected_url = resolve_native_http_redirect_url(current_url, location)?;
    let redirected_native_url = parse_native_http_url(&redirected_url)?;
    let mut redirected = current.clone();
    redirected.url = redirected_url;
    if should_rewrite_native_http_redirect_method(head.status, &redirected.method) {
        redirected.method = "GET".to_string();
        redirected.body.clear();
        redirected
            .headers
            .retain(|header| !matches!(header.name.as_str(), "content-type" | "content-length"));
    }
    if redirected_native_url.authority != current_url.authority {
        redirected
            .headers
            .retain(|header| !matches!(header.name.as_str(), "authorization" | "cookie"));
    }
    Ok(Some(redirected))
}

#[cfg(not(target_arch = "wasm32"))]
fn is_native_http_redirect_status(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

#[cfg(not(target_arch = "wasm32"))]
fn native_http_header_value<'a>(headers: &'a [HttpHeader], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find_map(|header| (header.name == name).then_some(header.value.as_str()))
}

#[cfg(not(target_arch = "wasm32"))]
fn should_rewrite_native_http_redirect_method(status: u16, method: &str) -> bool {
    (status == 303 && !matches!(method, "GET" | "HEAD"))
        || (matches!(status, 301 | 302) && method == "POST")
}

#[cfg(not(target_arch = "wasm32"))]
fn resolve_native_http_redirect_url(
    current: &NativeHttpUrl,
    location: &str,
) -> std::result::Result<String, HttpBridgeError> {
    let location = location.trim();
    if location.is_empty() {
        return Err(HttpBridgeError::invalid_response(
            "HTTP redirect location cannot be empty",
        ));
    }
    if location.starts_with("http://") || location.starts_with("https://") {
        return normalize_http_url(location.to_string()).map_err(|error| {
            HttpBridgeError::invalid_response(format!("invalid HTTP redirect location: {error}"))
        });
    }
    if location.starts_with("//") {
        return Ok(format!("http:{location}"));
    }

    let target = location
        .split_once('#')
        .map_or(location, |(before_fragment, _)| before_fragment);
    let target = if target.is_empty() {
        current.request_target.clone()
    } else if target.starts_with('/') {
        target.to_string()
    } else if target.starts_with('?') {
        format!("{}{}", native_http_redirect_base_path(current), target)
    } else {
        format!("{}{}", native_http_redirect_directory(current), target)
    };
    Ok(format!("http://{}{}", current.authority, target))
}

#[cfg(not(target_arch = "wasm32"))]
fn native_http_redirect_base_path(current: &NativeHttpUrl) -> String {
    current
        .request_target
        .split_once('?')
        .map_or(current.request_target.as_str(), |(path, _)| path)
        .to_string()
}

#[cfg(not(target_arch = "wasm32"))]
fn native_http_redirect_directory(current: &NativeHttpUrl) -> String {
    let path = native_http_redirect_base_path(current);
    let Some(index) = path.rfind('/') else {
        return "/".to_string();
    };
    if index == 0 {
        return "/".to_string();
    }
    path[..index + 1].to_string()
}

#[cfg(not(target_arch = "wasm32"))]
fn parse_native_http_response_headers(
    header_bytes: &[u8],
) -> std::result::Result<(u16, Vec<HttpHeader>, Option<usize>, bool), HttpBridgeError> {
    let text = std::str::from_utf8(header_bytes)
        .map_err(|_| HttpBridgeError::invalid_response("HTTP response headers must be UTF-8"))?;
    let mut lines = text.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = parse_native_http_status(status_line)?;
    let mut headers = Vec::new();
    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(HttpBridgeError::invalid_response(format!(
                "invalid HTTP response header: {line}"
            )));
        };
        let header = HttpHeader::new(name, value).map_err(|error| {
            HttpBridgeError::invalid_response(format!("invalid HTTP response header: {error}"))
        })?;
        if header.name == "content-length" {
            content_length = Some(header.value.parse::<usize>().map_err(|_| {
                HttpBridgeError::invalid_response(format!(
                    "invalid HTTP response content-length: {}",
                    header.value
                ))
            })?);
        }
        if header.name == "transfer-encoding" && is_chunked_transfer_encoding(&header.value) {
            chunked = true;
        }
        headers.push(header);
    }
    Ok((status, headers, content_length, chunked))
}

#[cfg(not(target_arch = "wasm32"))]
fn is_chunked_transfer_encoding(value: &str) -> bool {
    value
        .split(',')
        .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"))
}

#[cfg(not(target_arch = "wasm32"))]
fn parse_native_http_status(status_line: &str) -> std::result::Result<u16, HttpBridgeError> {
    let mut parts = status_line.split_whitespace();
    let version = parts.next().unwrap_or_default();
    let status = parts.next().unwrap_or_default();
    if !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return Err(HttpBridgeError::invalid_response(format!(
            "unsupported HTTP response version: {version}"
        )));
    }
    status.parse::<u16>().map_err(|_| {
        HttpBridgeError::invalid_response(format!("invalid HTTP response status: {status}"))
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn read_native_http_response_body_chunks<Consumer>(
    stream: &mut TcpStream,
    cancellation: &CancellationToken,
    head: NativeHttpResponseHead,
    body_limit: Option<usize>,
    mut consumer: Consumer,
) -> std::result::Result<(), HttpBridgeError>
where
    Consumer: FnMut(Vec<u8>) -> std::result::Result<(), HttpBridgeError>,
{
    let mut delivered_bytes = 0_usize;
    if head.chunked {
        read_chunked_native_http_body_chunks(
            stream,
            cancellation,
            head.body_prefix,
            body_limit,
            &mut delivered_bytes,
            &mut consumer,
        )
    } else if let Some(length) = head.content_length {
        let accepted = head.body_prefix.len().min(length);
        push_native_http_response_body_chunk(
            &mut consumer,
            &mut delivered_bytes,
            body_limit,
            head.body_prefix[..accepted].to_vec(),
        )?;
        read_fixed_native_http_body_chunks(
            stream,
            cancellation,
            length.saturating_sub(accepted),
            body_limit,
            &mut delivered_bytes,
            &mut consumer,
        )
    } else {
        push_native_http_response_body_chunk(
            &mut consumer,
            &mut delivered_bytes,
            body_limit,
            head.body_prefix,
        )?;
        read_until_eof_native_http_body_chunks(
            stream,
            cancellation,
            body_limit,
            &mut delivered_bytes,
            &mut consumer,
        )
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn read_chunked_native_http_body_chunks<Consumer>(
    stream: &mut TcpStream,
    cancellation: &CancellationToken,
    mut buffer: Vec<u8>,
    body_limit: Option<usize>,
    delivered_bytes: &mut usize,
    consumer: &mut Consumer,
) -> std::result::Result<(), HttpBridgeError>
where
    Consumer: FnMut(Vec<u8>) -> std::result::Result<(), HttpBridgeError>,
{
    loop {
        let size_line = read_native_http_line(
            stream,
            cancellation,
            &mut buffer,
            "chunked HTTP response chunk size",
        )?;
        let mut remaining = parse_native_http_chunk_size(&size_line)?;
        if remaining == 0 {
            read_native_http_trailers(stream, cancellation, &mut buffer)?;
            return Ok(());
        }

        while remaining > 0 {
            if buffer.is_empty()
                && read_more_native_http(
                    stream,
                    cancellation,
                    &mut buffer,
                    "chunked HTTP response body",
                )? == 0
            {
                return Err(HttpBridgeError::transport(
                    "HTTP connection closed before chunked response body completed",
                ));
            }

            let accepted = buffer.len().min(remaining);
            push_native_http_response_body_chunk(
                consumer,
                delivered_bytes,
                body_limit,
                buffer[..accepted].to_vec(),
            )?;
            buffer.drain(..accepted);
            remaining -= accepted;
        }

        ensure_native_http_buffer(
            stream,
            cancellation,
            &mut buffer,
            2,
            "chunked HTTP response chunk terminator",
        )?;
        if &buffer[..2] != b"\r\n" {
            return Err(HttpBridgeError::invalid_response(
                "chunked HTTP response chunk missing CRLF terminator",
            ));
        }
        buffer.drain(..2);
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn parse_native_http_chunk_size(line: &[u8]) -> std::result::Result<usize, HttpBridgeError> {
    let line = std::str::from_utf8(line).map_err(|_| {
        HttpBridgeError::invalid_response("chunked HTTP response chunk size must be UTF-8")
    })?;
    let size = line.split_once(';').map_or(line, |(size, _)| size).trim();
    if size.is_empty() {
        return Err(HttpBridgeError::invalid_response(
            "chunked HTTP response chunk size cannot be empty",
        ));
    }
    usize::from_str_radix(size, 16).map_err(|_| {
        HttpBridgeError::invalid_response(format!(
            "invalid chunked HTTP response chunk size: {size}"
        ))
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn read_native_http_trailers(
    stream: &mut TcpStream,
    cancellation: &CancellationToken,
    buffer: &mut Vec<u8>,
) -> std::result::Result<(), HttpBridgeError> {
    loop {
        let line = read_native_http_line(
            stream,
            cancellation,
            buffer,
            "chunked HTTP response trailers",
        )?;
        if line.is_empty() {
            return Ok(());
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn read_native_http_line(
    stream: &mut TcpStream,
    cancellation: &CancellationToken,
    buffer: &mut Vec<u8>,
    context: &str,
) -> std::result::Result<Vec<u8>, HttpBridgeError> {
    loop {
        if let Some(index) = find_crlf(buffer) {
            let line = buffer[..index].to_vec();
            buffer.drain(..index + 2);
            return Ok(line);
        }
        if buffer.len() > NATIVE_HTTP_HEADER_LIMIT {
            return Err(HttpBridgeError::invalid_response(format!(
                "{context} exceeded {NATIVE_HTTP_HEADER_LIMIT} bytes"
            )));
        }
        if read_more_native_http(stream, cancellation, buffer, context)? == 0 {
            return Err(HttpBridgeError::transport(format!(
                "HTTP connection closed before {context}"
            )));
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn ensure_native_http_buffer(
    stream: &mut TcpStream,
    cancellation: &CancellationToken,
    buffer: &mut Vec<u8>,
    length: usize,
    context: &str,
) -> std::result::Result<(), HttpBridgeError> {
    while buffer.len() < length {
        if read_more_native_http(stream, cancellation, buffer, context)? == 0 {
            return Err(HttpBridgeError::transport(format!(
                "HTTP connection closed before {context}"
            )));
        }
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn read_more_native_http(
    stream: &mut TcpStream,
    cancellation: &CancellationToken,
    buffer: &mut Vec<u8>,
    context: &str,
) -> std::result::Result<usize, HttpBridgeError> {
    let mut chunk = [0_u8; 4096];
    loop {
        if cancellation.is_cancelled() {
            return Err(HttpBridgeError::cancelled("HTTP request cancelled"));
        }
        match stream.read(&mut chunk) {
            Ok(count) => {
                buffer.extend_from_slice(&chunk[..count]);
                return Ok(count);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => {
                return Err(HttpBridgeError::transport(format!(
                    "unable to read {context}: {error}"
                )))
            }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn read_fixed_native_http_body_chunks<Consumer>(
    stream: &mut TcpStream,
    cancellation: &CancellationToken,
    mut remaining: usize,
    body_limit: Option<usize>,
    delivered_bytes: &mut usize,
    consumer: &mut Consumer,
) -> std::result::Result<(), HttpBridgeError>
where
    Consumer: FnMut(Vec<u8>) -> std::result::Result<(), HttpBridgeError>,
{
    let mut buffer = [0_u8; 8192];
    while remaining > 0 {
        if cancellation.is_cancelled() {
            return Err(HttpBridgeError::cancelled("HTTP request cancelled"));
        }
        let read_len = buffer.len().min(remaining);
        match stream.read(&mut buffer[..read_len]) {
            Ok(0) => return Err(HttpBridgeError::transport("HTTP response body ended early")),
            Ok(count) => {
                remaining -= count;
                push_native_http_response_body_chunk(
                    consumer,
                    delivered_bytes,
                    body_limit,
                    buffer[..count].to_vec(),
                )?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => {
                return Err(HttpBridgeError::transport(format!(
                    "unable to read HTTP response body: {error}"
                )))
            }
        }
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn read_until_eof_native_http_body_chunks<Consumer>(
    stream: &mut TcpStream,
    cancellation: &CancellationToken,
    body_limit: Option<usize>,
    delivered_bytes: &mut usize,
    consumer: &mut Consumer,
) -> std::result::Result<(), HttpBridgeError>
where
    Consumer: FnMut(Vec<u8>) -> std::result::Result<(), HttpBridgeError>,
{
    let mut buffer = [0_u8; 8192];
    loop {
        if cancellation.is_cancelled() {
            return Err(HttpBridgeError::cancelled("HTTP request cancelled"));
        }
        match stream.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => push_native_http_response_body_chunk(
                consumer,
                delivered_bytes,
                body_limit,
                buffer[..count].to_vec(),
            )?,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => {
                return Err(HttpBridgeError::transport(format!(
                    "unable to read HTTP response body: {error}"
                )))
            }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn push_native_http_response_body_chunk<Consumer>(
    consumer: &mut Consumer,
    delivered_bytes: &mut usize,
    body_limit: Option<usize>,
    chunk: Vec<u8>,
) -> std::result::Result<(), HttpBridgeError>
where
    Consumer: FnMut(Vec<u8>) -> std::result::Result<(), HttpBridgeError>,
{
    if chunk.is_empty() {
        return Ok(());
    }
    if let Some(limit) = body_limit {
        *delivered_bytes = delivered_bytes
            .checked_add(chunk.len())
            .ok_or_else(|| response_too_large_error(limit))?;
        if *delivered_bytes > limit {
            return Err(response_too_large_error(limit));
        }
    }
    consumer(chunk)
}

#[cfg(not(target_arch = "wasm32"))]
fn write_native_http_body_chunk(
    request: &HttpBridgeRequest,
    chunk: Vec<u8>,
) -> std::result::Result<(), HttpBridgeError> {
    if chunk.is_empty() {
        return Ok(());
    }
    request.write_body_chunk(chunk)
}

#[cfg(not(target_arch = "wasm32"))]
fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

#[cfg(not(target_arch = "wasm32"))]
fn find_crlf(buffer: &[u8]) -> Option<usize> {
    buffer.windows(2).position(|window| window == b"\r\n")
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

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[derive(Clone)]
    struct RecordingGatewayTransport {
        records: Arc<Mutex<Vec<GatewayRecord>>>,
        response: GatewayHttpResponse,
    }

    #[derive(Debug, Eq, PartialEq)]
    struct GatewayRecord {
        id: u64,
        method: String,
        url: String,
        headers: Vec<HttpHeader>,
        body_chunks: Vec<Vec<u8>>,
    }

    #[derive(Clone)]
    struct FailingGatewayTransport {
        error: HttpBridgeError,
    }

    #[derive(Clone)]
    struct BlockingUploadGatewayTransport {
        first_chunk_sender: mpsc::SyncSender<Vec<u8>>,
    }

    #[derive(Clone)]
    struct RecordingAsyncHttpTransport {
        records: Arc<Mutex<Vec<GatewayRecord>>>,
    }

    struct FailingAsyncHttpTransport {
        error: HttpBridgeError,
    }

    impl GatewayHttpTransport for RecordingGatewayTransport {
        fn dispatch(
            &self,
            mut request: GatewayHttpRequest,
            cancellation: CancellationToken,
        ) -> std::result::Result<GatewayHttpResponse, HttpBridgeError> {
            assert!(!cancellation.is_cancelled());
            let mut body_chunks = Vec::new();
            while let Some(chunk) = request.body.read_chunk_blocking()? {
                body_chunks.push(chunk);
            }
            self.records
                .lock()
                .expect("gateway records should lock")
                .push(GatewayRecord {
                    id: request.id,
                    method: request.method,
                    url: request.url,
                    headers: request.headers,
                    body_chunks,
                });
            Ok(self.response.clone())
        }
    }

    impl GatewayHttpTransport for FailingGatewayTransport {
        fn dispatch(
            &self,
            _request: GatewayHttpRequest,
            _cancellation: CancellationToken,
        ) -> std::result::Result<GatewayHttpResponse, HttpBridgeError> {
            Err(self.error.clone())
        }
    }

    impl GatewayHttpTransport for BlockingUploadGatewayTransport {
        fn dispatch(
            &self,
            mut request: GatewayHttpRequest,
            _cancellation: CancellationToken,
        ) -> std::result::Result<GatewayHttpResponse, HttpBridgeError> {
            let first_chunk = request
                .body
                .read_chunk_blocking()?
                .expect("streaming upload should include a first chunk");
            self.first_chunk_sender
                .send(first_chunk)
                .expect("first chunk should send");
            while request.body.read_chunk_blocking()?.is_some() {}
            GatewayHttpResponse::complete(200, Vec::new(), b"upload-ok".to_vec())
        }
    }

    impl AsyncHttpBridgeTransport for RecordingAsyncHttpTransport {
        fn dispatch<'a>(
            &'a self,
            mut request: GatewayHttpRequest,
            response: GatewayHttpResponseWriter,
            cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = std::result::Result<(), HttpBridgeError>> + 'a>> {
            Box::pin(async move {
                assert!(!cancellation.is_cancelled());
                let body = request.body.read_to_end_blocking()?;
                self.records
                    .lock()
                    .expect("async transport records should lock")
                    .push(GatewayRecord {
                        id: request.id,
                        method: request.method,
                        url: request.url,
                        headers: request.headers,
                        body_chunks: vec![body],
                    });
                response.write_body_chunk_async(b"hello ".to_vec()).await?;
                response.write_body_chunk_async(b"async".to_vec()).await?;
                response
                    .finish_async(
                        209,
                        vec![HttpHeader::new("x-async", "yes").expect("header should be valid")],
                        b" worker".to_vec(),
                    )
                    .await
            })
        }
    }

    impl AsyncHttpBridgeTransport for FailingAsyncHttpTransport {
        fn dispatch<'a>(
            &'a self,
            _request: GatewayHttpRequest,
            _response: GatewayHttpResponseWriter,
            _cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = std::result::Result<(), HttpBridgeError>> + 'a>> {
            Box::pin(async { Err(self.error.clone()) })
        }
    }

    #[test]
    fn async_http_bridge_worker_streams_chunks_on_current_thread_runtime() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("current-thread runtime should build");
        runtime.block_on(async {
            let records = Arc::new(Mutex::new(Vec::new()));
            let transport = RecordingAsyncHttpTransport {
                records: Arc::clone(&records),
            };
            let (bridge, receiver) = HttpBridge::new(1);
            let requester = async {
                let response = bridge
                    .request_async(
                        HttpRequest::new(
                            "post",
                            "https://example.test/async",
                            vec![
                                HttpHeader::new("x-test", "yes")
                                    .expect("header should be valid"),
                            ],
                            b"request-body".to_vec(),
                        )
                        .expect("request should be valid"),
                        HttpRequestLimits::default(),
                        CancellationSource::new().token(),
                    )
                    .await
                    .expect("async HTTP request should complete");
                drop(bridge);
                response
            };

            let ((), response) =
                tokio::join!(run_async_http_bridge_worker(receiver, transport), requester);

            assert_eq!(response.status, 209);
            assert_eq!(response.body, b"hello async worker");
            assert_eq!(
                response.headers,
                [HttpHeader::new("x-async", "yes").expect("header should be valid")]
            );
            assert_eq!(
                *records.lock().expect("async transport records should lock"),
                [GatewayRecord {
                    id: 1,
                    method: "POST".to_string(),
                    url: "https://example.test/async".to_string(),
                    headers: vec![
                        HttpHeader::new("x-test", "yes").expect("header should be valid")
                    ],
                    body_chunks: vec![b"request-body".to_vec()],
                }]
            );
        });
    }

    #[test]
    fn async_http_bridge_worker_preserves_transport_errors() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("current-thread runtime should build");
        runtime.block_on(async {
            let (bridge, receiver) = HttpBridge::new(1);
            let transport = FailingAsyncHttpTransport {
                error: HttpBridgeError::cors("request blocked by browser policy"),
            };
            let requester = async {
                let error = bridge
                    .request_async(
                        HttpRequest::new(
                            "get",
                            "https://example.test/blocked",
                            Vec::new(),
                            Vec::new(),
                        )
                        .expect("request should be valid"),
                        HttpRequestLimits::default(),
                        CancellationSource::new().token(),
                    )
                    .await
                    .expect_err("async HTTP request should fail");
                drop(bridge);
                error
            };

            let ((), error) =
                tokio::join!(run_async_http_bridge_worker(receiver, transport), requester);

            assert_eq!(error.kind, HttpBridgeErrorKind::Cors);
            assert_eq!(error.message, "request blocked by browser policy");
        });
    }

    #[test]
    fn native_http_response_reader_delivers_content_length_body() {
        let chunks = read_native_test_response_body_chunks(
            b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nhello world",
            None,
            CancellationSource::new().token(),
        )
        .expect("content-length response should read");

        assert_eq!(chunks.concat(), b"hello world");
    }

    #[test]
    fn native_http_response_reader_decodes_chunked_body_and_trailers() {
        let chunks = read_native_test_response_body_chunks(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n1; ext=value\r\n \r\n5\r\nworld\r\n0\r\nTrailer-Name: ignored\r\n\r\n",
            None,
            CancellationSource::new().token(),
        )
        .expect("chunked response should read");

        assert_eq!(chunks.concat(), b"hello world");
    }

    #[test]
    fn native_http_response_reader_delivers_eof_delimited_body() {
        let chunks = read_native_test_response_body_chunks(
            b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\neof-body",
            None,
            CancellationSource::new().token(),
        )
        .expect("EOF-delimited response should read");

        assert_eq!(chunks.concat(), b"eof-body");
    }

    #[test]
    fn native_http_response_reader_rejects_early_eof() {
        let error = read_native_test_response_body_chunks(
            b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\nshort",
            None,
            CancellationSource::new().token(),
        )
        .expect_err("early EOF should fail");

        assert_eq!(error.kind, HttpBridgeErrorKind::Transport);
        assert_eq!(error.message, "HTTP response body ended early");
    }

    #[test]
    fn native_http_response_reader_rejects_invalid_chunk_size() {
        let error = read_native_test_response_body_chunks(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nbad\r\n0\r\n\r\n",
            None,
            CancellationSource::new().token(),
        )
        .expect_err("invalid chunk size should fail");

        assert_eq!(error.kind, HttpBridgeErrorKind::InvalidResponse);
        assert!(error
            .message
            .contains("invalid chunked HTTP response chunk size"));
    }

    #[test]
    fn native_http_response_reader_observes_cancellation() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("local listener should bind");
        let address = listener.local_addr().expect("listener address should read");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("connection should arrive");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n")
                .expect("response headers should write");
            thread::sleep(Duration::from_millis(250));
        });

        let mut stream = TcpStream::connect(address).expect("client should connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("read timeout should set");
        let cancellation = CancellationSource::new();
        let token = cancellation.token();
        let head = read_native_http_response_head(&mut stream, &token)
            .expect("response headers should read");
        cancellation.cancel();
        let mut chunks = Vec::new();
        let error =
            read_native_http_response_body_chunks(&mut stream, &token, head, None, |chunk| {
                chunks.push(chunk);
                Ok(())
            })
            .expect_err("cancelled response body should fail");
        server.join().expect("server should finish");

        assert_eq!(error.kind, HttpBridgeErrorKind::Cancelled);
        assert_eq!(error.message, "HTTP request cancelled");
        assert!(chunks.is_empty());
    }

    #[test]
    fn native_http_response_reader_enforces_optional_body_limit() {
        let error = read_native_test_response_body_chunks(
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nlimit",
            Some(4),
            CancellationSource::new().token(),
        )
        .expect_err("response body limit should fail");

        assert_eq!(error.kind, HttpBridgeErrorKind::ResponseTooLarge);
        assert_eq!(error.message, "HTTP response body exceeded 4 bytes");
    }

    #[test]
    fn gateway_http_bridge_worker_dispatches_buffered_request_and_response_chunks() {
        let records = Arc::new(Mutex::new(Vec::new()));
        let transport = RecordingGatewayTransport {
            records: Arc::clone(&records),
            response: GatewayHttpResponse::chunks(
                207,
                vec![HttpHeader::new("x-gateway", "yes").expect("header should be valid")],
                vec![b"hello ".to_vec(), b"gateway".to_vec()],
            )
            .expect("response should be valid"),
        };
        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = GatewayHttpBridgeWorker::spawn(receiver, transport);
        let response = bridge
            .request_blocking(
                HttpRequest::new(
                    "post",
                    "https://example.test/gateway",
                    vec![HttpHeader::new("x-test", "yes").expect("header should be valid")],
                    b"request-body".to_vec(),
                )
                .expect("request should be valid"),
                HttpRequestLimits::default(),
                CancellationSource::new().token(),
            )
            .expect("gateway request should complete");

        assert_eq!(response.status, 207);
        assert_eq!(response.body, b"hello gateway");
        assert_eq!(
            response.headers,
            [HttpHeader::new("x-gateway", "yes").expect("header should be valid")]
        );
        assert_eq!(
            *records.lock().expect("gateway records should lock"),
            [GatewayRecord {
                id: 1,
                method: "POST".to_string(),
                url: "https://example.test/gateway".to_string(),
                headers: vec![HttpHeader::new("x-test", "yes").expect("header should be valid")],
                body_chunks: vec![b"request-body".to_vec()],
            }]
        );
    }

    #[test]
    fn gateway_http_bridge_worker_dispatches_streaming_request_body() {
        let records = Arc::new(Mutex::new(Vec::new()));
        let transport = RecordingGatewayTransport {
            records: Arc::clone(&records),
            response: GatewayHttpResponse::complete(200, Vec::new(), b"streamed".to_vec())
                .expect("response should be valid"),
        };
        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = GatewayHttpBridgeWorker::spawn(receiver, transport);
        let response = bridge
            .request_streaming_blocking(
                HttpRequest::new("put", "https://example.test/upload", Vec::new(), Vec::new())
                    .expect("request should be valid"),
                HttpRequestLimits::default(),
                CancellationSource::new().token(),
                |body| {
                    body.write_chunk_blocking(b"hello ".to_vec())?;
                    body.write_chunk_blocking(b"stream".to_vec())
                },
            )
            .expect("gateway streaming request should complete");

        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"streamed");
        assert_eq!(
            records
                .lock()
                .expect("gateway records should lock")
                .first()
                .expect("gateway request should be recorded")
                .body_chunks,
            [b"hello ".to_vec(), b"stream".to_vec()]
        );
    }

    #[test]
    fn gateway_http_bridge_worker_times_out_while_waiting_for_stream_upload_chunk() {
        let (first_chunk_sender, first_chunk_receiver) = mpsc::sync_channel(1);
        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = GatewayHttpBridgeWorker::spawn(
            receiver,
            BlockingUploadGatewayTransport { first_chunk_sender },
        );
        let result = bridge.request_streaming_blocking(
            HttpRequest::new("put", "https://example.test/upload", Vec::new(), Vec::new())
                .expect("request should be valid"),
            HttpRequestLimits {
                response_body_bytes: 1024,
                wall_time: Some(Duration::from_millis(50)),
            },
            CancellationSource::new().token(),
            |body| {
                body.write_chunk_blocking(b"first".to_vec())?;
                thread::sleep(Duration::from_millis(250));
                body.write_chunk_blocking(b"late".to_vec())
            },
        );

        assert_eq!(
            first_chunk_receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("first upload chunk should reach transport"),
            b"first"
        );
        let error = result.expect_err("streaming upload should time out");
        assert_eq!(error.kind, HttpBridgeErrorKind::Timeout);
        assert_eq!(error.message, "HTTP request exceeded wall time limit");
    }

    #[test]
    fn gateway_http_bridge_worker_cancels_while_waiting_for_stream_upload_chunk() {
        let (first_chunk_sender, first_chunk_receiver) = mpsc::sync_channel(1);
        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = GatewayHttpBridgeWorker::spawn(
            receiver,
            BlockingUploadGatewayTransport { first_chunk_sender },
        );
        let cancellation = CancellationSource::new();
        let token = cancellation.token();
        let runner = thread::spawn(move || {
            bridge.request_streaming_blocking(
                HttpRequest::new("put", "https://example.test/upload", Vec::new(), Vec::new())
                    .expect("request should be valid"),
                HttpRequestLimits {
                    response_body_bytes: 1024,
                    wall_time: None,
                },
                token,
                |body| {
                    body.write_chunk_blocking(b"first".to_vec())?;
                    thread::sleep(Duration::from_millis(250));
                    body.write_chunk_blocking(b"late".to_vec())
                },
            )
        });

        assert_eq!(
            first_chunk_receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("first upload chunk should reach transport"),
            b"first"
        );
        cancellation.cancel();
        let error = runner
            .join()
            .expect("runner should finish")
            .expect_err("streaming upload should be cancelled");
        assert_eq!(error.kind, HttpBridgeErrorKind::Cancelled);
        assert_eq!(error.message, "HTTP request cancelled");
    }

    #[test]
    fn gateway_http_bridge_worker_preserves_transport_errors() {
        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = GatewayHttpBridgeWorker::spawn(
            receiver,
            FailingGatewayTransport {
                error: HttpBridgeError::cors("request blocked by gateway policy"),
            },
        );
        let error = bridge
            .request_blocking(
                HttpRequest::new("get", "https://example.test/api", Vec::new(), Vec::new())
                    .expect("request should be valid"),
                HttpRequestLimits::default(),
                CancellationSource::new().token(),
            )
            .expect_err("gateway transport error should be returned");

        assert_eq!(error.kind, HttpBridgeErrorKind::Cors);
        assert_eq!(error.message, "request blocked by gateway policy");
    }

    #[test]
    fn native_gateway_http_transport_cancels_while_waiting_for_stream_response() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("local listener should bind");
        let address = listener.local_addr().expect("listener address should read");
        let (request_sender, request_receiver) = mpsc::sync_channel(1);
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("gateway connection should arrive");
            let request = read_test_http_request(&mut stream);
            request_sender.send(request).expect("request should send");
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .expect("gateway response headers should write");
            let frame = br#"{"type":"response","status":200,"headers":[]}
"#;
            write!(stream, "{:x}\r\n", frame.len()).expect("gateway chunk size should write");
            stream
                .write_all(frame)
                .expect("gateway response frame should write");
            stream
                .write_all(b"\r\n")
                .expect("gateway chunk terminator should write");
            thread::sleep(Duration::from_millis(250));
        });

        let (bridge, receiver) = HttpBridge::new(4);
        let transport = NativeGatewayHttpTransport::new(format!("http://{address}/bridge"))
            .expect("gateway transport should initialize");
        let _worker = GatewayHttpBridgeWorker::spawn(receiver, transport);
        let cancellation = CancellationSource::new();
        let token = cancellation.token();
        let runner = thread::spawn(move || {
            bridge.request_blocking(
                HttpRequest::new(
                    "get",
                    "https://example.test/gateway-cancel",
                    Vec::new(),
                    Vec::new(),
                )
                .expect("request should be valid"),
                HttpRequestLimits {
                    response_body_bytes: 1024,
                    wall_time: None,
                },
                token,
            )
        });

        let request = request_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("gateway request should arrive");
        assert!(request.starts_with("POST /bridge HTTP/1.1\r\n"));

        cancellation.cancel();
        let error = runner
            .join()
            .expect("runner should finish")
            .expect_err("request should be cancelled");
        server.join().expect("gateway server should finish");

        assert_eq!(error.kind, HttpBridgeErrorKind::Cancelled);
        assert_eq!(error.message, "HTTP request cancelled");
    }

    #[test]
    fn native_http_bridge_dispatches_local_response() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("local listener should bind");
        let address = listener.local_addr().expect("listener address should read");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("connection should arrive");
            let request = read_test_http_request(&mut stream);
            assert!(request.starts_with("POST /hello?x=1 HTTP/1.1\r\n"));
            assert!(request.contains("Host: 127.0.0.1:"));
            assert!(request.contains("x-test: yes\r\n"));
            assert!(request.ends_with("\r\n\r\nrequest-body"));

            stream
                .write_all(
                    b"HTTP/1.1 202 Accepted\r\nContent-Length: 11\r\nX-Reply: ok\r\n\r\nhello ",
                )
                .expect("response prefix should write");
            stream
                .write_all(b"world")
                .expect("response suffix should write");
        });

        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = NativeHttpBridgeWorker::spawn(receiver);
        let response = bridge
            .request_blocking(
                HttpRequest::new(
                    "post",
                    format!("http://{address}/hello?x=1"),
                    vec![HttpHeader::new("x-test", "yes").expect("header should be valid")],
                    b"request-body".to_vec(),
                )
                .expect("request should be valid"),
                HttpRequestLimits::default(),
                CancellationSource::new().token(),
            )
            .expect("HTTP request should complete");
        server.join().expect("server should finish");

        assert_eq!(response.status, 202);
        assert_eq!(response.body, b"hello world");
        assert!(response
            .headers
            .contains(&HttpHeader::new("x-reply", "ok").expect("response header should be valid")));
    }

    #[test]
    fn native_http_bridge_decodes_chunked_response() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("local listener should bind");
        let address = listener.local_addr().expect("listener address should read");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("connection should arrive");
            let request = read_test_http_request(&mut stream);
            assert!(request.starts_with("GET /chunked HTTP/1.1\r\n"));

            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nX-Reply: chunked\r\n\r\n5\r\nhello\r\n",
                )
                .expect("response prefix should write");
            stream
                .write_all(b"1; ext=value\r\n \r\n5\r\nworld\r\n0\r\nTrailer-Name: ignored\r\n\r\n")
                .expect("response suffix should write");
        });

        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = NativeHttpBridgeWorker::spawn(receiver);
        let response = bridge
            .request_blocking(
                HttpRequest::new(
                    "get",
                    format!("http://{address}/chunked"),
                    Vec::new(),
                    Vec::new(),
                )
                .expect("request should be valid"),
                HttpRequestLimits::default(),
                CancellationSource::new().token(),
            )
            .expect("HTTP request should complete");
        server.join().expect("server should finish");

        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"hello world");
        assert!(response.headers.contains(
            &HttpHeader::new("transfer-encoding", "chunked")
                .expect("response header should be valid")
        ));
    }

    #[test]
    fn native_http_bridge_handles_query_only_url_and_strips_fragment() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("local listener should bind");
        let address = listener.local_addr().expect("listener address should read");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("connection should arrive");
            let request = read_test_http_request(&mut stream);
            assert!(request.starts_with("GET /?token=yes HTTP/1.1\r\n"));
            assert!(!request.contains("client-fragment"));

            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .expect("response should write");
        });

        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = NativeHttpBridgeWorker::spawn(receiver);
        let response = bridge
            .request_blocking(
                HttpRequest::new(
                    "get",
                    format!("http://{address}?token=yes#client-fragment"),
                    Vec::new(),
                    Vec::new(),
                )
                .expect("request should be valid"),
                HttpRequestLimits::default(),
                CancellationSource::new().token(),
            )
            .expect("HTTP request should complete");
        server.join().expect("server should finish");

        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"ok");
    }

    #[test]
    fn native_http_bridge_follows_redirect_and_rewrites_post_to_get() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("local listener should bind");
        let address = listener.local_addr().expect("listener address should read");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("first connection should arrive");
            let request = read_test_http_request(&mut stream);
            assert!(request.starts_with("POST /start HTTP/1.1\r\n"));
            assert!(request.ends_with("\r\n\r\nrequest-body"));
            stream
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: /final?x=1#client-only\r\nContent-Length: 13\r\n\r\nredirect-body",
                )
                .expect("redirect response should write");

            let (mut stream, _) = listener
                .accept()
                .expect("redirect connection should arrive");
            let request = read_test_http_request(&mut stream);
            assert!(request.starts_with("GET /final?x=1 HTTP/1.1\r\n"));
            assert!(!request.contains("client-only"));
            assert!(request.contains("Content-Length: 0\r\n"));
            assert!(!request.ends_with("request-body"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ndone")
                .expect("final response should write");
        });

        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = NativeHttpBridgeWorker::spawn(receiver);
        let response = bridge
            .request_blocking(
                HttpRequest::new(
                    "post",
                    format!("http://{address}/start"),
                    vec![HttpHeader::new("content-type", "text/plain")
                        .expect("header should be valid")],
                    b"request-body".to_vec(),
                )
                .expect("request should be valid"),
                HttpRequestLimits::default(),
                CancellationSource::new().token(),
            )
            .expect("redirected HTTP request should complete");
        server.join().expect("server should finish");

        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"done");
    }

    #[test]
    fn native_http_bridge_sends_streaming_request_body_as_chunked() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("local listener should bind");
        let address = listener.local_addr().expect("listener address should read");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("connection should arrive");
            let request = read_chunked_test_http_request(&mut stream);
            assert!(request.starts_with("POST /stream HTTP/1.1\r\n"));
            assert!(request
                .to_ascii_lowercase()
                .contains("transfer-encoding: chunked\r\n"));
            assert!(!request.contains("Content-Length:"));
            assert!(request.ends_with("\r\n6\r\nhello \r\n6\r\nstream\r\n0\r\n\r\n"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nuploaded")
                .expect("response should write");
        });

        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = NativeHttpBridgeWorker::spawn(receiver);
        let response = bridge
            .request_streaming_blocking(
                HttpRequest::new(
                    "post",
                    format!("http://{address}/stream"),
                    Vec::new(),
                    Vec::new(),
                )
                .expect("request should be valid"),
                HttpRequestLimits::default(),
                CancellationSource::new().token(),
                |body| {
                    body.write_chunk_blocking(b"hello ".to_vec())?;
                    body.write_chunk_blocking(b"stream".to_vec())
                },
            )
            .expect("streaming HTTP request should complete");
        server.join().expect("server should finish");

        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"uploaded");
    }

    #[test]
    fn native_http_bridge_strips_sensitive_headers_on_cross_authority_redirect() {
        let target_listener =
            TcpListener::bind("127.0.0.1:0").expect("target listener should bind");
        let target_address = target_listener
            .local_addr()
            .expect("target listener address should read");
        let target_server = thread::spawn(move || {
            let (mut stream, _) = target_listener
                .accept()
                .expect("redirect target connection should arrive");
            let request = read_test_http_request(&mut stream);
            assert!(request.starts_with("GET /target HTTP/1.1\r\n"));
            assert!(!request.contains("authorization:"));
            assert!(!request.contains("cookie:"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\ntarget")
                .expect("target response should write");
        });

        let redirect_listener =
            TcpListener::bind("127.0.0.1:0").expect("redirect listener should bind");
        let redirect_address = redirect_listener
            .local_addr()
            .expect("redirect listener address should read");
        let redirect_server = thread::spawn(move || {
            let (mut stream, _) = redirect_listener
                .accept()
                .expect("redirect connection should arrive");
            let request = read_test_http_request(&mut stream);
            assert!(request.contains("authorization: Bearer secret\r\n"));
            assert!(request.contains("cookie: session=secret\r\n"));
            write!(
                stream,
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{target_address}/target\r\nContent-Length: 0\r\n\r\n"
            )
            .expect("redirect response should write");
        });

        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = NativeHttpBridgeWorker::spawn(receiver);
        let response = bridge
            .request_blocking(
                HttpRequest::new(
                    "get",
                    format!("http://{redirect_address}/start"),
                    vec![
                        HttpHeader::new("authorization", "Bearer secret")
                            .expect("authorization should be valid"),
                        HttpHeader::new("cookie", "session=secret")
                            .expect("cookie should be valid"),
                    ],
                    Vec::new(),
                )
                .expect("request should be valid"),
                HttpRequestLimits::default(),
                CancellationSource::new().token(),
            )
            .expect("redirected HTTP request should complete");
        redirect_server
            .join()
            .expect("redirect server should finish");
        target_server.join().expect("target server should finish");

        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"target");
    }

    #[test]
    fn native_http_bridge_rejects_empty_host_as_invalid_request() {
        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = NativeHttpBridgeWorker::spawn(receiver);
        let error = bridge
            .request_blocking(
                HttpRequest::new("GET", "http://:80/", Vec::new(), Vec::new())
                    .expect("request should be syntactically valid for bridge dispatch"),
                HttpRequestLimits::default(),
                CancellationSource::new().token(),
            )
            .expect_err("native worker should reject empty host");

        assert_eq!(error.kind, HttpBridgeErrorKind::InvalidRequest);
        assert!(error.message.contains("host cannot be empty"));
    }

    #[test]
    fn native_http_bridge_rejects_userinfo_without_leaking_secret_url_parts() {
        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = NativeHttpBridgeWorker::spawn(receiver);
        let error = bridge
            .request_blocking(
                HttpRequest::new(
                    "GET",
                    "http://user:secret@127.0.0.1:80/private?token=secret",
                    Vec::new(),
                    Vec::new(),
                )
                .expect("request should normalize"),
                HttpRequestLimits::default(),
                CancellationSource::new().token(),
            )
            .expect_err("native worker should reject userinfo");

        assert_eq!(error.kind, HttpBridgeErrorKind::InvalidRequest);
        assert_eq!(
            error.message,
            "HTTP request URL must include a host without userinfo"
        );
        assert!(!error.message.contains("secret"));
        assert!(!error.message.contains("token"));
        assert!(!error.message.contains("private"));
    }

    #[test]
    fn native_http_bridge_rejects_https_until_tls_adapter_exists() {
        let (bridge, receiver) = HttpBridge::new(4);
        let _worker = NativeHttpBridgeWorker::spawn(receiver);
        let error = bridge
            .request_blocking(
                HttpRequest::new("GET", "https://example.test/", Vec::new(), Vec::new())
                    .expect("request should be valid"),
                HttpRequestLimits::default(),
                CancellationSource::new().token(),
            )
            .expect_err("native worker should reject https");

        assert_eq!(error.kind, HttpBridgeErrorKind::UnsupportedScheme);
        assert!(error.message.contains("https"));
    }

    fn read_native_test_response_body_chunks(
        response: &'static [u8],
        body_limit: Option<usize>,
        cancellation: CancellationToken,
    ) -> std::result::Result<Vec<Vec<u8>>, HttpBridgeError> {
        let listener = TcpListener::bind("127.0.0.1:0").expect("local listener should bind");
        let address = listener.local_addr().expect("listener address should read");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("connection should arrive");
            stream
                .write_all(response)
                .expect("test HTTP response should write");
        });

        let mut stream = TcpStream::connect(address).expect("client should connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("read timeout should set");
        let head = read_native_http_response_head(&mut stream, &cancellation)?;
        let mut chunks = Vec::new();
        let result = read_native_http_response_body_chunks(
            &mut stream,
            &cancellation,
            head,
            body_limit,
            |chunk| {
                chunks.push(chunk);
                Ok(())
            },
        );
        server.join().expect("server should finish");

        result.map(|()| chunks)
    }

    fn read_test_http_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("read timeout should set");
        let mut buffer = Vec::new();
        let header_end = loop {
            if let Some(index) = find_header_end(&buffer) {
                break index;
            }
            let mut chunk = [0_u8; 1024];
            let count = stream.read(&mut chunk).expect("request should read");
            assert!(count > 0, "request should include headers");
            buffer.extend_from_slice(&chunk[..count]);
        };
        let header = String::from_utf8(buffer[..header_end].to_vec())
            .expect("request headers should be utf8");
        let content_length = header
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    return Some(value.trim().parse::<usize>().expect("content length"));
                }
                None
            })
            .unwrap_or(0);
        let body_start = header_end + 4;
        while buffer.len() - body_start < content_length {
            let mut chunk = [0_u8; 1024];
            let count = stream.read(&mut chunk).expect("request body should read");
            assert!(count > 0, "request body should be complete");
            buffer.extend_from_slice(&chunk[..count]);
        }
        String::from_utf8(buffer).expect("request should be utf8")
    }

    fn read_chunked_test_http_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("read timeout should set");
        let mut buffer = Vec::new();
        loop {
            let mut chunk = [0_u8; 1024];
            let count = stream.read(&mut chunk).expect("request should read");
            assert!(count > 0, "request should include chunked body");
            buffer.extend_from_slice(&chunk[..count]);
            if buffer.ends_with(b"0\r\n\r\n") {
                break;
            }
            assert!(buffer.len() < 8192, "chunked request exceeded 8 KiB");
        }
        String::from_utf8(buffer).expect("request should be utf8")
    }
}
