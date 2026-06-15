use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Command as ProcessCommand, Output},
    sync::mpsc,
    thread,
    time::Duration,
};

use serde_json::{json, Value};
use wasm_host_fixtures::{
    http_bridge_fixture_webc, http_bridge_fixture_webc_with_options,
    http_bridge_fixture_webc_with_response_body_limit,
    http_bridge_invalid_stream_frame_fixture_webc, http_bridge_streaming_upload_fixture_webc,
    HttpBridgeFixtureOptions, HTTP_BRIDGE_COMMAND,
};

#[test]
fn native_http_bridge_is_available_to_wasi_guest() {
    let mut server = TestHttpServer::spawn();
    let webc = http_bridge_fixture_webc(&server.url()).expect("build HTTP bridge fixture");
    let output = run_native_http_bridge_fixture(webc, "http-fixture.webc");
    let response = parse_fixture_stdout(&output);
    assert_eq!(response["ok"], true);
    assert_eq!(response["response"]["status"], 200);
    assert_eq!(response["response"]["body_base64"], "YnJpZGdlLW9r");

    let events = String::from_utf8(output.stderr).expect("stderr should be UTF-8");
    assert!(
        events.contains(r#""http_bridge":"native""#),
        "runner events should include the native bridge mode:\n{events}"
    );
    assert!(
        events.contains(r#""event":"command.completed""#),
        "runner events should include command completion:\n{events}"
    );

    let request = server.request();
    assert!(
        request.starts_with("GET /http-bridge-fixture HTTP/1.1\r\n"),
        "unexpected request line:\n{request}"
    );
    assert!(
        request.contains("x-fixture: wasm-host-runner\r\n"),
        "missing fixture header:\n{request}"
    );
}

#[test]
fn native_http_bridge_redirect_is_visible_to_wasi_guest() {
    let mut server = RedirectHttpServer::spawn();
    let webc = http_bridge_fixture_webc(&server.url()).expect("build HTTP bridge fixture");
    let output = run_native_http_bridge_fixture(webc, "http-redirect-fixture.webc");
    let response = parse_fixture_stdout(&output);
    assert_eq!(response["ok"], true);
    assert_eq!(response["response"]["status"], 200);
    assert_eq!(
        response["response"]["body_base64"],
        "Z3Vlc3QtcmVkaXJlY3Qtb2s="
    );

    let (start_request, final_request) = server.requests();
    assert!(
        start_request.starts_with("GET /start HTTP/1.1\r\n"),
        "unexpected redirect request line:\n{start_request}"
    );
    assert!(
        start_request.contains("x-fixture: wasm-host-runner\r\n"),
        "missing fixture header on redirect request:\n{start_request}"
    );
    assert!(
        final_request.starts_with("GET /final?from=runner HTTP/1.1\r\n"),
        "unexpected final request line:\n{final_request}"
    );
    assert!(
        !final_request.contains("client-only"),
        "client fragment should not be sent to the server:\n{final_request}"
    );
    assert!(
        final_request.contains("x-fixture: wasm-host-runner\r\n"),
        "missing fixture header on final request:\n{final_request}"
    );
}

#[test]
fn native_http_bridge_unsupported_scheme_error_is_visible_to_wasi_guest() {
    let webc = http_bridge_fixture_webc("https://example.test/http-bridge-fixture")
        .expect("build HTTP bridge fixture");
    let output = run_native_http_bridge_fixture(webc, "http-unsupported-scheme-fixture.webc");
    let response = parse_fixture_stdout(&output);

    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["kind"], "unsupported_scheme");
    let message = response["error"]["message"]
        .as_str()
        .expect("error message should be a string");
    assert!(
        message.contains("supports http:// URLs only"),
        "unexpected unsupported scheme error: {message}"
    );
}

#[test]
fn native_http_bridge_response_limit_error_is_visible_to_wasi_guest() {
    let mut server =
        TestHttpServer::spawn_with_response("/http-bridge-too-large", b"response-body-too-large");
    let webc = http_bridge_fixture_webc_with_response_body_limit(&server.url(), 4)
        .expect("build HTTP bridge fixture");
    let output = run_native_http_bridge_fixture(webc, "http-response-limit-fixture.webc");
    let response = parse_fixture_stdout(&output);

    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["kind"], "response_too_large");
    assert_eq!(
        response["error"]["message"],
        "HTTP response body exceeded 4 bytes"
    );

    let request = server.request();
    assert!(
        request.starts_with("GET /http-bridge-too-large HTTP/1.1\r\n"),
        "unexpected request line:\n{request}"
    );
}

#[test]
fn native_http_bridge_gateway_unavailable_error_is_visible_to_wasi_guest() {
    let webc = http_bridge_fixture_webc(&closed_local_http_url("/http-bridge-unavailable"))
        .expect("build HTTP bridge fixture");
    let output = run_native_http_bridge_fixture(webc, "http-gateway-unavailable-fixture.webc");
    let response = parse_fixture_stdout(&output);

    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["kind"], "gateway_unavailable");
    let message = response["error"]["message"]
        .as_str()
        .expect("error message should be a string");
    assert!(
        message.contains("unable to connect to HTTP host 127.0.0.1:"),
        "unexpected gateway unavailable error: {message}"
    );
}

#[test]
fn native_http_bridge_timeout_error_is_visible_to_wasi_guest() {
    let mut server = SlowHttpServer::spawn(
        "/http-bridge-timeout",
        Duration::from_millis(250),
        b"too-late",
    );
    let webc = http_bridge_fixture_webc_with_options(
        &server.url(),
        HttpBridgeFixtureOptions {
            timeout_ms: Some(50),
            ..HttpBridgeFixtureOptions::default()
        },
    )
    .expect("build HTTP bridge fixture");
    let output = run_native_http_bridge_fixture(webc, "http-timeout-fixture.webc");
    let response = parse_fixture_stdout(&output);

    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["kind"], "timeout");
    assert_eq!(
        response["error"]["message"],
        "HTTP request exceeded wall time limit"
    );

    let request = server.request();
    assert!(
        request.starts_with("GET /http-bridge-timeout HTTP/1.1\r\n"),
        "unexpected request line:\n{request}"
    );
}

#[test]
fn native_http_bridge_streaming_upload_is_visible_to_wasi_guest() {
    let mut server = StreamingUploadHttpServer::spawn();
    let webc = http_bridge_streaming_upload_fixture_webc(&server.url())
        .expect("build HTTP streaming upload fixture");
    let output = run_native_http_bridge_fixture(webc, "http-streaming-upload-fixture.webc");
    let response = parse_fixture_stdout(&output);

    assert_eq!(response["ok"], true);
    assert_eq!(response["response"]["status"], 200);
    assert_eq!(response["response"]["body_base64"], "dXBsb2FkLW9r");

    let request = server.request();
    assert!(
        request.starts_with("POST /http-bridge-upload HTTP/1.1\r\n"),
        "unexpected request line:\n{request}"
    );
    assert!(
        request.contains("x-fixture: wasm-host-runner\r\n"),
        "missing fixture header:\n{request}"
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked\r\n"),
        "missing chunked transfer encoding:\n{request}"
    );
    assert!(
        !request.to_ascii_lowercase().contains("content-length:"),
        "streaming upload should not send Content-Length:\n{request}"
    );
    assert!(
        request.ends_with("\r\n6\r\nguest-\r\n6\r\nupload\r\n0\r\n\r\n"),
        "unexpected chunked body:\n{request}"
    );
}

#[test]
fn native_http_bridge_invalid_device_request_is_visible_to_wasi_guest() {
    let webc = http_bridge_invalid_stream_frame_fixture_webc().expect("build invalid HTTP fixture");
    let output = run_native_http_bridge_fixture(webc, "http-invalid-request-fixture.webc");
    let response = parse_fixture_stdout(&output);

    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["kind"], "invalid_request");
    let message = response["error"]["message"]
        .as_str()
        .expect("error message should be a string");
    assert!(
        message.contains("must start with a request frame"),
        "unexpected invalid request error: {message}"
    );
}

#[test]
fn gateway_http_bridge_is_available_to_wasi_guest() {
    let mut gateway = GatewayHttpServer::spawn(json!({
        "ok": true,
        "response": {
            "status": 201,
            "headers": [{"name": "x-gateway", "value": "yes"}],
            "body_chunks_base64": ["Z2F0ZXdheS0=", "b2s="]
        }
    }));
    let webc = http_bridge_fixture_webc("https://example.test/http-bridge-fixture")
        .expect("build HTTP bridge fixture");
    let output = run_http_bridge_fixture(
        webc,
        "http-gateway-fixture.webc",
        &format!("gateway={}", gateway.url()),
    );
    let response = parse_fixture_stdout(&output);

    assert_eq!(response["ok"], true);
    assert_eq!(response["response"]["status"], 201);
    assert_eq!(response["response"]["body_base64"], "Z2F0ZXdheS1vaw==");

    let events = String::from_utf8(output.stderr).expect("stderr should be UTF-8");
    assert!(
        events.contains(r#""http_bridge":"gateway""#),
        "runner events should include gateway bridge mode:\n{events}"
    );
    assert!(
        !events.contains(&gateway.url()),
        "runner events should not include gateway endpoint URLs:\n{events}"
    );

    let request = gateway.request();
    assert!(
        request.head.starts_with("POST /bridge HTTP/1.1\r\n"),
        "unexpected gateway request line:\n{}",
        request.head
    );
    assert_eq!(request.body["schema"], 1);
    assert_eq!(request.body["method"], "GET");
    assert_eq!(
        request.body["url"],
        "https://example.test/http-bridge-fixture"
    );
    assert_eq!(request.body["body_chunks_base64"], json!([]));
    assert_eq!(
        request.body["headers"],
        json!([{"name": "x-fixture", "value": "wasm-host-runner"}])
    );
}

#[test]
fn gateway_http_bridge_error_is_visible_to_wasi_guest() {
    let mut gateway = GatewayHttpServer::spawn(json!({
        "ok": false,
        "error": {
            "kind": "cors",
            "message": "request blocked by gateway policy"
        }
    }));
    let webc = http_bridge_fixture_webc("https://example.test/http-bridge-fixture")
        .expect("build HTTP bridge fixture");
    let output = run_http_bridge_fixture(
        webc,
        "http-gateway-error-fixture.webc",
        &format!("gateway={}", gateway.url()),
    );
    let response = parse_fixture_stdout(&output);

    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["kind"], "cors");
    assert_eq!(
        response["error"]["message"],
        "request blocked by gateway policy"
    );

    let request = gateway.request();
    assert_eq!(
        request.body["url"],
        "https://example.test/http-bridge-fixture"
    );
}

#[test]
fn gateway_http_bridge_preserves_streaming_upload_chunks() {
    let mut gateway = GatewayHttpServer::spawn(json!({
        "ok": true,
        "response": {
            "status": 200,
            "headers": [],
            "body_base64": "dXBsb2FkLW9r"
        }
    }));
    let webc = http_bridge_streaming_upload_fixture_webc("https://example.test/upload")
        .expect("build HTTP streaming upload fixture");
    let output = run_http_bridge_fixture(
        webc,
        "http-gateway-streaming-upload-fixture.webc",
        &format!("gateway={}", gateway.url()),
    );
    let response = parse_fixture_stdout(&output);

    assert_eq!(response["ok"], true);
    assert_eq!(response["response"]["status"], 200);
    assert_eq!(response["response"]["body_base64"], "dXBsb2FkLW9r");

    let request = gateway.request();
    assert!(
        request
            .head
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked\r\n"),
        "gateway streaming request should use chunked transfer encoding:\n{}",
        request.head
    );
    assert_eq!(
        request.frames,
        vec![
            json!({
                "type": "request",
                "schema": 1,
                "id": 1,
                "method": "POST",
                "url": "https://example.test/upload",
                "headers": [{"name": "x-fixture", "value": "wasm-host-runner"}]
            }),
            json!({"type": "body_chunk", "body_base64": "Z3Vlc3Qt"}),
            json!({"type": "body_chunk", "body_base64": "dXBsb2Fk"}),
            json!({"type": "body_end"}),
        ]
    );
}

fn run_native_http_bridge_fixture(webc: Vec<u8>, webc_filename: &str) -> Output {
    run_http_bridge_fixture(webc, webc_filename, "native")
}

fn run_http_bridge_fixture(webc: Vec<u8>, webc_filename: &str, http_bridge: &str) -> Output {
    let tmp = tempfile::tempdir().expect("temp dir");
    let webc_path = tmp.path().join(webc_filename);
    std::fs::write(&webc_path, webc).expect("write WebC fixture");

    ProcessCommand::new(env!("CARGO_BIN_EXE_wasm-host-runner"))
        .arg("--event-format")
        .arg("json")
        .arg("--http-bridge")
        .arg(http_bridge)
        .arg("--module-cache-dir")
        .arg(tmp.path().join("modules"))
        .arg("--webc")
        .arg(&webc_path)
        .arg("--")
        .arg(HTTP_BRIDGE_COMMAND)
        .output()
        .expect("run fixture package")
}

fn parse_fixture_stdout(output: &Output) -> serde_json::Value {
    assert!(
        output.status.success(),
        "runner failed with status {:?}\nstdout:\n{}\nstderr:\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "fixture stdout should be JSON: {error}\nstdout bytes: {:?}\nstdout:\n{}\nstderr:\n{}",
            output.stdout,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn closed_local_http_url(path: &str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind closed local port");
    let address = listener.local_addr().expect("read closed local address");
    drop(listener);
    format!("http://{address}{path}")
}

struct TestHttpServer {
    url: String,
    request_receiver: mpsc::Receiver<String>,
    handle: Option<thread::JoinHandle<()>>,
}

impl TestHttpServer {
    fn spawn() -> Self {
        Self::spawn_with_response("/http-bridge-fixture", b"bridge-ok")
    }

    fn spawn_with_response(path: &str, response_body: &[u8]) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test HTTP server");
        let address = listener.local_addr().expect("read server address");
        let response_body = response_body.to_vec();
        let (request_sender, request_receiver) = mpsc::sync_channel(1);
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept test request");
            let request = handle_test_http_request(stream, &response_body);
            request_sender.send(request).expect("send captured request");
        });
        Self {
            url: format!("http://{address}{path}"),
            request_receiver,
            handle: Some(handle),
        }
    }

    fn url(&self) -> String {
        self.url.clone()
    }

    fn request(&mut self) -> String {
        let request = self
            .request_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("receive captured HTTP request");
        if let Some(handle) = self.handle.take() {
            handle.join().expect("test HTTP server should exit cleanly");
        }
        request
    }
}

struct RedirectHttpServer {
    url: String,
    request_receiver: mpsc::Receiver<(String, String)>,
    handle: Option<thread::JoinHandle<()>>,
}

impl RedirectHttpServer {
    fn spawn() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind redirect HTTP server");
        let address = listener.local_addr().expect("read redirect server address");
        let (request_sender, request_receiver) = mpsc::sync_channel(1);
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept redirect request");
            let start_request = read_test_http_request(&mut stream);
            stream
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: /final?from=runner#client-only\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .expect("write redirect response");

            let (mut stream, _) = listener.accept().expect("accept final request");
            let final_request = read_test_http_request(&mut stream);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 17\r\nConnection: close\r\n\r\nguest-redirect-ok",
                )
                .expect("write final response");
            request_sender
                .send((start_request, final_request))
                .expect("send captured redirect requests");
        });
        Self {
            url: format!("http://{address}/start"),
            request_receiver,
            handle: Some(handle),
        }
    }

    fn url(&self) -> String {
        self.url.clone()
    }

    fn requests(&mut self) -> (String, String) {
        let requests = self
            .request_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("receive captured redirect HTTP requests");
        if let Some(handle) = self.handle.take() {
            handle
                .join()
                .expect("redirect HTTP server should exit cleanly");
        }
        requests
    }
}

struct SlowHttpServer {
    url: String,
    request_receiver: mpsc::Receiver<String>,
    handle: Option<thread::JoinHandle<()>>,
}

impl SlowHttpServer {
    fn spawn(path: &str, delay: Duration, response_body: &'static [u8]) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind slow HTTP server");
        let address = listener.local_addr().expect("read slow server address");
        let (request_sender, request_receiver) = mpsc::sync_channel(1);
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept slow request");
            let request = read_test_http_request(&mut stream);
            request_sender
                .send(request)
                .expect("send captured slow request");
            thread::sleep(delay);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_body.len()
            );
            let _ = stream.write_all(response_body);
        });
        Self {
            url: format!("http://{address}{path}"),
            request_receiver,
            handle: Some(handle),
        }
    }

    fn url(&self) -> String {
        self.url.clone()
    }

    fn request(&mut self) -> String {
        let request = self
            .request_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("receive captured slow HTTP request");
        if let Some(handle) = self.handle.take() {
            handle.join().expect("slow HTTP server should exit cleanly");
        }
        request
    }
}

struct StreamingUploadHttpServer {
    url: String,
    request_receiver: mpsc::Receiver<String>,
    handle: Option<thread::JoinHandle<()>>,
}

impl StreamingUploadHttpServer {
    fn spawn() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind upload HTTP server");
        let address = listener.local_addr().expect("read upload server address");
        let (request_sender, request_receiver) = mpsc::sync_channel(1);
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept upload request");
            let request = read_chunked_test_http_request(&mut stream);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nupload-ok",
                )
                .expect("write upload response");
            request_sender
                .send(request)
                .expect("send captured upload request");
        });
        Self {
            url: format!("http://{address}/http-bridge-upload"),
            request_receiver,
            handle: Some(handle),
        }
    }

    fn url(&self) -> String {
        self.url.clone()
    }

    fn request(&mut self) -> String {
        let request = self
            .request_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("receive captured upload request");
        if let Some(handle) = self.handle.take() {
            handle
                .join()
                .expect("upload HTTP server should exit cleanly");
        }
        request
    }
}

struct GatewayHttpServer {
    url: String,
    request_receiver: mpsc::Receiver<GatewayHttpRequestCapture>,
    handle: Option<thread::JoinHandle<()>>,
}

struct GatewayHttpRequestCapture {
    head: String,
    body: Value,
    frames: Vec<Value>,
}

impl GatewayHttpServer {
    fn spawn(response_body: Value) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind gateway HTTP server");
        let address = listener.local_addr().expect("read gateway server address");
        let (request_sender, request_receiver) = mpsc::sync_channel(1);
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept gateway request");
            let request = read_gateway_http_request(&mut stream);
            let response_body =
                serde_json::to_vec(&response_body).expect("gateway response should encode");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_body.len()
            )
            .expect("write gateway response headers");
            stream
                .write_all(&response_body)
                .expect("write gateway response body");
            request_sender
                .send(request)
                .expect("send captured gateway request");
        });
        Self {
            url: format!("http://{address}/bridge"),
            request_receiver,
            handle: Some(handle),
        }
    }

    fn url(&self) -> String {
        self.url.clone()
    }

    fn request(&mut self) -> GatewayHttpRequestCapture {
        let request = self
            .request_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("receive captured gateway HTTP request");
        if let Some(handle) = self.handle.take() {
            handle
                .join()
                .expect("gateway HTTP server should exit cleanly");
        }
        request
    }
}

fn handle_test_http_request(mut stream: TcpStream, response_body: &[u8]) -> String {
    let request = read_test_http_request(&mut stream);
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response_body.len()
    )
    .expect("write HTTP response headers");
    stream
        .write_all(response_body)
        .expect("write HTTP response body");
    request
}

fn read_test_http_request_with_body(stream: &mut TcpStream) -> (String, Vec<u8>) {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("gateway read timeout should set");
    let mut data = Vec::new();
    let mut buffer = [0_u8; 512];
    let header_end = loop {
        let length = stream.read(&mut buffer).expect("read HTTP request");
        assert!(length > 0, "HTTP request should include headers");
        data.extend_from_slice(&buffer[..length]);
        if let Some(index) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        assert!(data.len() < 8192, "HTTP request headers exceeded 8 KiB");
    };
    let mut body = data.split_off(header_end);
    let head = String::from_utf8(data).expect("HTTP request head should be UTF-8");
    if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        while !body.ends_with(b"0\r\n\r\n") {
            let length = stream.read(&mut buffer).expect("read chunked HTTP body");
            assert!(length > 0, "chunked HTTP body ended early");
            body.extend_from_slice(&buffer[..length]);
            assert!(
                body.len() <= 1024 * 1024,
                "chunked HTTP body exceeded 1 MiB"
            );
        }
        return (head, body);
    }
    let content_length = content_length_from_head(&head);
    while body.len() < content_length {
        let length = stream.read(&mut buffer).expect("read HTTP request body");
        assert!(length > 0, "HTTP request body ended early");
        body.extend_from_slice(&buffer[..length]);
        assert!(
            body.len() <= 1024 * 1024,
            "HTTP request body exceeded 1 MiB"
        );
    }
    body.truncate(content_length);
    (head, body)
}

fn read_gateway_http_request(stream: &mut TcpStream) -> GatewayHttpRequestCapture {
    let (head, body) = read_test_http_request_with_body(stream);
    if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        let decoded = decode_test_chunked_body(&body);
        let frames = decoded
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).expect("gateway frame should be JSON"))
            .collect::<Vec<_>>();
        return GatewayHttpRequestCapture {
            head,
            body: Value::Null,
            frames,
        };
    }

    let body: Value = serde_json::from_slice(&body).expect("gateway body should be JSON");
    GatewayHttpRequestCapture {
        head,
        body,
        frames: Vec::new(),
    }
}

fn decode_test_chunked_body(body: &[u8]) -> Vec<u8> {
    let mut decoded = Vec::new();
    let mut offset = 0;
    loop {
        let line_end = find_bytes(&body[offset..], b"\r\n").expect("chunk size should end in CRLF");
        let size_text = std::str::from_utf8(&body[offset..offset + line_end])
            .expect("chunk size should be UTF-8");
        let size = usize::from_str_radix(size_text.trim(), 16).expect("chunk size should be hex");
        offset += line_end + 2;
        if size == 0 {
            break;
        }
        decoded.extend_from_slice(&body[offset..offset + size]);
        offset += size;
        assert_eq!(&body[offset..offset + 2], b"\r\n");
        offset += 2;
    }
    decoded
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn content_length_from_head(head: &str) -> usize {
    head.lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse().ok()
            } else {
                None
            }
        })
        .expect("HTTP request should include Content-Length")
}

fn read_test_http_request(stream: &mut TcpStream) -> String {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 512];
    loop {
        let length = stream.read(&mut buffer).expect("read HTTP request");
        if length == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..length]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        assert!(request.len() < 8192, "HTTP request headers exceeded 8 KiB");
    }
    String::from_utf8(request).expect("HTTP request should be UTF-8")
}

fn read_chunked_test_http_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("upload read timeout should set");
    let mut request = Vec::new();
    let mut buffer = [0_u8; 512];
    loop {
        let length = stream.read(&mut buffer).expect("read upload HTTP request");
        assert!(length > 0, "upload request should include chunked body");
        request.extend_from_slice(&buffer[..length]);
        if request.ends_with(b"0\r\n\r\n") {
            break;
        }
        assert!(request.len() < 8192, "upload HTTP request exceeded 8 KiB");
    }
    String::from_utf8(request).expect("upload HTTP request should be UTF-8")
}
