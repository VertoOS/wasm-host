use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Command as ProcessCommand,
    sync::mpsc,
    thread,
    time::Duration,
};

use wasm_host_fixtures::{http_bridge_fixture_webc, HTTP_BRIDGE_COMMAND};

#[test]
fn native_http_bridge_is_available_to_wasi_guest() {
    let mut server = TestHttpServer::spawn();
    let webc = http_bridge_fixture_webc(&server.url()).expect("build HTTP bridge fixture");
    let tmp = tempfile::tempdir().expect("temp dir");
    let webc_path = tmp.path().join("http-fixture.webc");
    std::fs::write(&webc_path, webc).expect("write WebC fixture");

    let output = ProcessCommand::new(env!("CARGO_BIN_EXE_wasm-host-runner"))
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
        .expect("run fixture package");

    assert!(
        output.status.success(),
        "runner failed with status {:?}\nstdout:\n{}\nstderr:\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let response: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("fixture stdout should be JSON");
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
    let tmp = tempfile::tempdir().expect("temp dir");
    let webc_path = tmp.path().join("http-redirect-fixture.webc");
    std::fs::write(&webc_path, webc).expect("write WebC fixture");

    let output = ProcessCommand::new(env!("CARGO_BIN_EXE_wasm-host-runner"))
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
        .expect("run fixture package");

    assert!(
        output.status.success(),
        "runner failed with status {:?}\nstdout:\n{}\nstderr:\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let response: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("fixture stdout should be JSON");
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

struct TestHttpServer {
    url: String,
    request_receiver: mpsc::Receiver<String>,
    handle: Option<thread::JoinHandle<()>>,
}

impl TestHttpServer {
    fn spawn() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test HTTP server");
        let address = listener.local_addr().expect("read server address");
        let (request_sender, request_receiver) = mpsc::sync_channel(1);
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept test request");
            let request = handle_test_http_request(stream);
            request_sender.send(request).expect("send captured request");
        });
        Self {
            url: format!("http://{address}/http-bridge-fixture"),
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

fn handle_test_http_request(mut stream: TcpStream) -> String {
    let request = read_test_http_request(&mut stream);
    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nbridge-ok")
        .expect("write HTTP response");
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
