//! V2-10c: a fake CDN on 127.0.0.1 standing in for all five hosts. It records each raw request (request line and
//! header lines, as received) and answers from a route. Each test starts its own.
use std::{
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

pub type Route = Box<dyn Fn(&str) -> Answer + Send + Sync>;
pub enum Answer {
    Bytes(Vec<u8>),
    /// Waits, then answers.
    Late(Duration, Vec<u8>),
}
/// One received request: the request line, then each header line, without the CRLF.
pub type Raw = Vec<String>;
pub struct Origin {
    pub port: u16,
    hits: Arc<Mutex<Vec<Raw>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
}
impl Origin {
    pub fn start(route: Route) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(Mutex::new(vec![]));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (h, route, s) = (hits.clone(), Arc::new(route), stop.clone());
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                // A stopped origin answers nothing: the connection is closed at once.
                if s.load(std::sync::atomic::Ordering::SeqCst) {
                    drop(stream);
                    continue;
                }
                let (h, route) = (h.clone(), route.clone());
                thread::spawn(move || serve(stream, &h, &route));
            }
        });
        Self { port, hits, stop }
    }
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }
    pub fn count(&self) -> usize {
        self.hits.lock().unwrap().len()
    }
    pub fn requests(&self) -> Vec<Raw> {
        self.hits.lock().unwrap().clone()
    }
    pub fn paths(&self) -> Vec<String> {
        self.requests()
            .iter()
            .map(|r| r[0].split(' ').nth(1).unwrap_or("").to_string())
            .collect()
    }
    /// From now on nothing is answered or recorded.
    pub fn stop(&self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}
fn serve(mut stream: TcpStream, hits: &Mutex<Vec<Raw>>, route: &Route) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut raw = vec![];
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        raw.push(line.trim_end_matches("\r\n").to_string());
    }
    if raw.is_empty() {
        return;
    }
    let path = raw[0].split(' ').nth(1).unwrap_or("").to_string();
    hits.lock().unwrap().push(raw);
    match route(&path) {
        Answer::Bytes(b) => {
            let _ = stream.write_all(&b);
        }
        Answer::Late(wait, b) => {
            thread::sleep(wait);
            let _ = stream.write_all(&b);
        }
    }
}
pub fn ok(body: &[u8]) -> Answer {
    Answer::Bytes(ok_bytes(body))
}
pub fn ok_bytes(body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}
pub fn status(code: u16, extra: &str) -> Answer {
    Answer::Bytes(
        format!("HTTP/1.1 {code} X\r\nContent-Length: 0\r\n{extra}Connection: close\r\n\r\n")
            .into_bytes(),
    )
}
