//! CONNECT-only egress. Resolve once, reject the entire answer set, dial the checked IP.
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    os::fd::AsRawFd,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};
pub fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, _, _] = v.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 0 || b == 168))
                || (a == 198 && (b == 18 || b == 19 || b == 51))
                || (a == 203 && b == 0))
        }
        // Refuse special IPv6 ranges, including mapped IPv4 and translation/tunnel prefixes.
        IpAddr::V6(v) => {
            let s = v.segments();
            (0x2000..=0x3fff).contains(&s[0])
                && s[0] != 0x2002
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
        }
    }
}
pub fn checked_addresses(
    host: &str,
    approved: &[String],
    resolve: impl FnOnce(&str) -> Result<Vec<IpAddr>, String>,
) -> Result<Vec<IpAddr>, String> {
    if !approved.iter().any(|h| h == host) {
        return Err("unapproved host".into());
    }
    let addresses = resolve(host)?;
    if addresses.is_empty() || addresses.iter().any(|ip| !public_address(*ip)) {
        return Err("resolved address refused".into());
    }
    Ok(addresses)
}
/// How long a client may take to send its request headers.
const HEADER_DEADLINE: Duration = Duration::from_secs(2);
/// Q9 psn-J21-3: how long one address may take to accept. A distant host (Korea to the US, 150 ms and more a round
/// trip) needs longer than the old 150 ms; 5 s also covers two lost SYNs.
const DIAL_DEADLINE: Duration = Duration::from_secs(5);
/// Q9 psn-J21-2: a tunnel ends after this long with no byte either way (it was cut 30 s after it opened, mid-transfer).
const IDLE: Duration = Duration::from_secs(30);
/// Q9 psn-J21-4: how long one relayed chunk (up to 16 KiB) may take to be taken by its reader before the tunnel ends;
/// a 200 ms limit lost the bytes of a reader that paused briefly. A total per chunk, not per write call, so a reader
/// that takes a few bytes at a time cannot hold the handler (security look 11-19).
const WRITE_DEADLINE: Duration = Duration::from_secs(5);
/// One write call's timeout inside `write_within`: how often a stuck write sees a stop.
const WRITE_TICK: Duration = Duration::from_millis(200);
pub struct Proxy {
    pub port: u16,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Proxy {
    pub fn start(approved: &[String]) -> Result<Self, String> {
        Self::start_holding(approved, HEADER_DEADLINE)
    }
    // v1a-17: a test seam. A test holding a half-sent request raises the header deadline, so only a stop can end
    // that request; `start` keeps HEADER_DEADLINE.
    #[doc(hidden)]
    pub fn start_holding(approved: &[String], header_deadline: Duration) -> Result<Self, String> {
        Self::start_with(
            approved,
            header_deadline,
            |host| {
                (host, 443)
                    .to_socket_addrs()
                    .map(|a| a.map(|s| s.ip()).collect())
                    .map_err(|e| e.to_string())
            },
            |address| TcpStream::connect_timeout(&address, DIAL_DEADLINE),
        )
    }
    fn start_with(
        approved: &[String],
        header_deadline: Duration,
        resolve: fn(&str) -> Result<Vec<IpAddr>, String>,
        dial: fn(SocketAddr) -> std::io::Result<TcpStream>,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let approved: BTreeSet<_> = approved.iter().cloned().collect();
        let active = Arc::new(AtomicUsize::new(0));
        let worker = thread::spawn(move || {
            let mut clients = vec![];
            while !stopping.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if active.load(Ordering::Relaxed) >= 16 {
                            drop(stream);
                            continue;
                        }
                        let allowed = approved.clone();
                        let done = stopping.clone();
                        let active = active.clone();
                        active.fetch_add(1, Ordering::Relaxed);
                        clients.push(thread::spawn(move || {
                            let _ =
                                connect(stream, &allowed, &done, header_deadline, resolve, dial);
                            active.fetch_sub(1, Ordering::Relaxed);
                        }));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
                let mut i = 0;
                while i < clients.len() {
                    if clients[i].is_finished() {
                        let _ = clients.swap_remove(i).join();
                    } else {
                        i += 1;
                    }
                }
            }
            for c in clients {
                let _ = c.join();
            }
        });
        Ok(Self {
            port,
            stop,
            worker: Some(worker),
        })
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}
fn connect(
    mut client: TcpStream,
    approved: &BTreeSet<String>,
    stop: &AtomicBool,
    header_deadline: Duration,
    resolve: fn(&str) -> Result<Vec<IpAddr>, String>,
    dial: fn(SocketAddr) -> std::io::Result<TcpStream>,
) -> Result<(), String> {
    client
        .set_read_timeout(Some(Duration::from_millis(200)))
        .map_err(|e| e.to_string())?;
    client
        .set_write_timeout(Some(WRITE_TICK))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![];
    let start = std::time::Instant::now();
    while !bytes.ends_with(b"\r\n\r\n") {
        if stop.load(Ordering::Relaxed) || start.elapsed() > header_deadline || bytes.len() >= 8192
        {
            return Err("proxy header limit".into());
        }
        let mut b = [0];
        match client.read(&mut b) {
            Ok(0) => return Ok(()),
            Ok(_) => bytes.push(b[0]),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let header = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
    let mut request = header.lines().next().unwrap_or("").split_whitespace();
    let method = request.next();
    let target = request.next().unwrap_or("");
    let version = request.next();
    let Some(host) = target.strip_suffix(":443") else {
        client.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n").ok();
        return Ok(());
    };
    if method != Some("CONNECT")
        || version != Some("HTTP/1.1")
        || request.next().is_some()
        || !approved.contains(host)
    {
        client.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n").ok();
        return Ok(());
    }
    let allowed = approved.iter().cloned().collect::<Vec<_>>();
    // libc DNS has no cancellation API. Bound waiters and outstanding resolver jobs.
    static RESOLVING: AtomicUsize = AtomicUsize::new(0);
    let addresses = checked_addresses(host, &allowed, |h| {
        RESOLVING
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                (n < 16).then_some(n + 1)
            })
            .map_err(|_| "resolver busy")?;
        let (send, receive) = std::sync::mpsc::channel();
        let host = h.to_string();
        thread::spawn(move || {
            let result = resolve(&host);
            let _ = send.send(result);
            RESOLVING.fetch_sub(1, Ordering::Relaxed);
        });
        let begin = std::time::Instant::now();
        loop {
            if stop.load(Ordering::Relaxed) || begin.elapsed() > Duration::from_millis(500) {
                return Err("resolver timeout".into());
            }
            match receive.recv_timeout(Duration::from_millis(20)) {
                Ok(result) => return result,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(e) => return Err(e.to_string()),
            }
        }
    });
    let Ok(addresses) = addresses else {
        client.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n").ok();
        return Ok(());
    };
    let mut remote = None;
    for ip in addresses.into_iter().take(4) {
        // The dial runs on its own thread so a stop is seen while one waits out DIAL_DEADLINE (Drop joins this
        // handler); an abandoned dial ends by its own timeout. At most 16 handlers, so at most 16 such threads.
        let (send, receive) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let _ = send.send(dial(SocketAddr::new(ip, 443)));
        });
        let dialed = loop {
            if stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            match receive.recv_timeout(Duration::from_millis(20)) {
                Ok(result) => break result.ok(),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break None,
            }
        };
        if let Some(stream) = dialed {
            remote = Some(stream);
            break;
        }
    }
    let mut remote = remote.ok_or("proxy connect failed")?;
    remote
        .set_read_timeout(Some(Duration::from_millis(50)))
        .map_err(|e| e.to_string())?;
    remote
        .set_write_timeout(Some(WRITE_TICK))
        .map_err(|e| e.to_string())?;
    client
        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
        .map_err(|e| e.to_string())?;
    let mut buffer = [0; 16384];
    let mut last = std::time::Instant::now();
    while !stop.load(Ordering::Relaxed) && last.elapsed() < IDLE {
        // Q9 psn-J21-1: wait on both sides at once and read only a ready one, so an idle side (the client during a
        // download) no longer costs its 200 ms read timeout on every pass.
        let mut ready = [client.as_raw_fd(), remote.as_raw_fd()].map(|fd| libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        });
        // SAFETY: `ready` is a live array of two pollfd for the duration of the call.
        unsafe { libc::poll(ready.as_mut_ptr(), 2, 200) };
        for (direction, side) in ready.iter().enumerate() {
            if side.revents == 0 {
                continue;
            }
            let (from, to) = if direction == 0 {
                (&mut client, &mut remote)
            } else {
                (&mut remote, &mut client)
            };
            match from.read(&mut buffer) {
                Ok(0) => return Ok(()),
                Ok(n) => {
                    write_within(to, &buffer[..n], stop)?;
                    last = std::time::Instant::now();
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::TimedOut
                        || e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(e.to_string()),
            }
        }
    }
    Ok(())
}
/// Writes all of `bytes` within WRITE_DEADLINE, seeing a stop every WRITE_TICK (the socket's write timeout).
fn write_within(to: &mut TcpStream, mut bytes: &[u8], stop: &AtomicBool) -> Result<(), String> {
    let begin = std::time::Instant::now();
    while !bytes.is_empty() {
        if stop.load(Ordering::Relaxed) {
            return Err("proxy stopped".into());
        }
        if begin.elapsed() > WRITE_DEADLINE {
            return Err("proxy peer not reading".into());
        }
        match to.write(bytes) {
            Ok(0) => return Err("proxy peer closed".into()),
            Ok(n) => bytes = &bytes[n..],
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    static PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);
    #[test]
    fn sandbox_proxy_approved_public_host_with_fake_resolver_and_loopback_target() {
        let target = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        PORT.store(target.local_addr().unwrap().port(), Ordering::Relaxed);
        let worker = thread::spawn(move || {
            let (mut stream, _) = target.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut b = [0; 4];
            stream.read_exact(&mut b).unwrap();
            assert_eq!(&b, b"ping");
            stream.write_all(b"pong").unwrap();
        });
        let proxy = Proxy::start_with(
            &["public.example".into()],
            HEADER_DEADLINE,
            |host| {
                assert_eq!(host, "public.example");
                Ok(vec!["93.184.216.34".parse().unwrap()])
            },
            |address| {
                assert_eq!(address, "93.184.216.34:443".parse().unwrap());
                TcpStream::connect((Ipv4Addr::LOCALHOST, PORT.load(Ordering::Relaxed)))
            },
        )
        .unwrap();
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        client
            .write_all(b"CONNECT public.example:443 HTTP/1.1\r\n\r\n")
            .unwrap();
        let mut response = vec![];
        while !response.ends_with(b"\r\n\r\n") {
            let mut b = [0];
            client.read_exact(&mut b).unwrap();
            response.push(b[0]);
        }
        assert!(response.starts_with(b"HTTP/1.1 200"));
        client.write_all(b"ping").unwrap();
        let mut b = [0; 4];
        client.read_exact(&mut b).unwrap();
        assert_eq!(&b, b"pong");
        drop(client);
        drop(proxy);
        worker.join().unwrap();
    }
    /// Q9 psn-J21-3: a dial that takes longer than the old 150 ms still tunnels, and a dial that never answers does not
    /// hold the proxy's drop (it would have for the whole dial before, which made a long dial deadline unsafe).
    #[test]
    fn sandbox_proxy_waits_for_a_slow_dial_and_a_stop_ends_a_hung_one() {
        static TARGET: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);
        static HUNG: AtomicBool = AtomicBool::new(false);
        let target = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        TARGET.store(target.local_addr().unwrap().port(), Ordering::Relaxed);
        let ask = |port: u16| {
            let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            client
                .write_all(b"CONNECT public.example:443 HTTP/1.1\r\n\r\n")
                .unwrap();
            client
        };
        let resolve: fn(&str) -> Result<Vec<IpAddr>, String> =
            |_| Ok(vec!["93.184.216.34".parse().unwrap()]);
        let slow = Proxy::start_with(&["public.example".into()], HEADER_DEADLINE, resolve, |_| {
            thread::sleep(Duration::from_millis(400));
            TcpStream::connect((Ipv4Addr::LOCALHOST, TARGET.load(Ordering::Relaxed)))
        })
        .unwrap();
        let mut client = ask(slow.port);
        let mut b = [0; 12];
        client.read_exact(&mut b).unwrap();
        assert_eq!(&b, b"HTTP/1.1 200");
        drop(client);
        drop(slow);
        let hung = Proxy::start_with(&["public.example".into()], HEADER_DEADLINE, resolve, |_| {
            HUNG.store(true, Ordering::Relaxed);
            thread::sleep(Duration::from_secs(60));
            Err(std::io::ErrorKind::TimedOut.into())
        })
        .unwrap();
        let _client = ask(hung.port);
        let begin = std::time::Instant::now();
        while !HUNG.load(Ordering::Relaxed) {
            assert!(
                begin.elapsed() < Duration::from_secs(10),
                "the dial never started"
            );
            thread::sleep(Duration::from_millis(10));
        }
        let begin = std::time::Instant::now();
        drop(hung);
        assert!(
            begin.elapsed() < Duration::from_secs(5),
            "dropping the proxy waited for a hung dial"
        );
    }
    /// Security look 11-19 on Q9 psn-J21-4: a reader that takes a few bytes at a time ends the tunnel once a chunk
    /// waits WRITE_DEADLINE in all, and a stop ends a handler stuck in that write at once.
    #[test]
    fn sandbox_proxy_ends_a_trickling_reader_and_a_stop_ends_its_write() {
        static TARGET: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);
        let target = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        // A small receive buffer (copied to each accepted socket) so each small read lets the proxy write a little.
        let size: libc::c_int = 1024;
        // SAFETY: a live socket, and an option value of the length given.
        unsafe {
            libc::setsockopt(
                target.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_RCVBUF,
                (&size as *const libc::c_int).cast(),
                std::mem::size_of_val(&size) as libc::socklen_t,
            )
        };
        TARGET.store(target.local_addr().unwrap().port(), Ordering::Relaxed);
        thread::spawn(move || {
            for stream in target.incoming().take(2) {
                let mut stream = stream.unwrap();
                thread::spawn(move || {
                    let mut b = [0; 600];
                    for _ in 0..60 {
                        if matches!(stream.read(&mut b), Ok(0) | Err(_)) {
                            return;
                        }
                        thread::sleep(Duration::from_millis(500));
                    }
                });
            }
        });
        let open = || {
            let proxy = Proxy::start_with(
                &["public.example".into()],
                HEADER_DEADLINE,
                |_| Ok(vec!["93.184.216.34".parse().unwrap()]),
                |_| TcpStream::connect((Ipv4Addr::LOCALHOST, TARGET.load(Ordering::Relaxed))),
            )
            .unwrap();
            let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port)).unwrap();
            client
                .write_all(b"CONNECT public.example:443 HTTP/1.1\r\n\r\n")
                .unwrap();
            let mut b = [0; 39];
            client.read_exact(&mut b).unwrap();
            assert!(b.starts_with(b"HTTP/1.1 200"));
            // Sends until the tunnel is closed.
            let (send, ended) = std::sync::mpsc::channel();
            thread::spawn(move || {
                while client.write_all(&[7; 16384]).is_ok() {}
                let _ = send.send(());
            });
            (proxy, ended)
        };
        let (proxy, ended) = open();
        assert!(
            ended.recv_timeout(Duration::from_secs(20)).is_ok(),
            "a trickling reader kept the tunnel open"
        );
        drop(proxy);
        let (proxy, _ended) = open();
        // Long enough for the proxy's send buffer to fill, so the handler sits in a write.
        thread::sleep(Duration::from_millis(1500));
        let begin = std::time::Instant::now();
        drop(proxy);
        assert!(
            begin.elapsed() < Duration::from_secs(1),
            "dropping the proxy waited for a write to a trickling reader: {:?}",
            begin.elapsed()
        );
    }
}
