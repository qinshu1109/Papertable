use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread::JoinHandle;
use std::time::Duration;

pub(crate) struct TestResponse {
    pub(crate) headers: Vec<(&'static str, &'static str)>,
    pub(crate) body: String,
}

impl TestResponse {
    pub(crate) fn json(body: impl Into<String>) -> Self {
        Self {
            headers: vec![],
            body: body.into(),
        }
    }
}

pub(crate) struct TestRequest {
    pub(crate) headers: BTreeMap<String, String>,
    pub(crate) body: String,
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<TestRequest> {
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte)?;
        head.push(byte[0]);
        if head.len() > 64 * 1024 {
            return Err(std::io::Error::other("test request headers too large"));
        }
    }
    let head = String::from_utf8(head).map_err(|error| std::io::Error::other(error.to_string()))?;
    let mut headers = BTreeMap::new();
    for line in head.split("\r\n").skip(1).filter(|line| !line.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| std::io::Error::other("invalid test request header"))?;
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    let length = headers
        .get("content-length")
        .map(|value| value.parse::<usize>())
        .transpose()
        .map_err(|error| std::io::Error::other(error.to_string()))?
        .unwrap_or_default();
    let mut body = vec![0; length];
    stream.read_exact(&mut body)?;
    Ok(TestRequest {
        headers,
        body: String::from_utf8(body).map_err(|error| std::io::Error::other(error.to_string()))?,
    })
}

/// Serves every response on one accepted socket. A client that does not reuse
/// its pooled connection cannot complete the second request.
pub(crate) fn serve_keep_alive(
    responses: Vec<TestResponse>,
) -> (String, JoinHandle<Vec<TestRequest>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let total = responses.len();
        let mut requests = Vec::with_capacity(total);
        for (index, response) in responses.into_iter().enumerate() {
            requests.push(read_request(&mut stream).unwrap());
            let mut head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
                response.body.len()
            );
            for (name, value) in response.headers {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
            head.push_str(if index + 1 == total {
                "Connection: close\r\n\r\n"
            } else {
                "Connection: keep-alive\r\n\r\n"
            });
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(response.body.as_bytes()).unwrap();
            stream.flush().unwrap();
        }
        requests
    });
    (format!("http://{address}/test"), handle)
}
