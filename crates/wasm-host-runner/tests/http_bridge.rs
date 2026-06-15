use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Command as ProcessCommand, Output},
    sync::mpsc,
    thread,
    time::Duration,
};

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

fn run_native_http_bridge_fixture(webc: Vec<u8>, webc_filename: &str) -> Output {
    let tmp = tempfile::tempdir().expect("temp dir");
    let webc_path = tmp.path().join(webc_filename);
    std::fs::write(&webc_path, webc).expect("write WebC fixture");

    ProcessCommand::new(env!("CARGO_BIN_EXE_wasm-host-runner"))
        .arg("--event-format")
        .arg("json")
        .arg("--http-bridge")
        .arg("native")
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
