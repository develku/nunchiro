//! V2-1a: the holder socket's frames. The hello (each side's first frame) and the `stop` op are frozen: every later
//! core or holder reads them, so a version mismatch can still be named and a holder of any version ended.
//! After the hello, a frame is a big-endian u32 length (of the op byte and payload), the op byte, then the payload.
use std::io::{self, Read, Write};

pub const MAGIC: [u8; 8] = *b"NUNHOLD\0";
pub const PROTOCOL: u16 = 2;
pub const MIN_COMPATIBLE: u16 = 1;
/// A spawn frame carries the seed (at most the 1 MiB replay plus the resume marker), argv and the environment.
pub const MAX_FRAME: usize = 4 << 20;

// Core to holder. `STOP` is frozen.
pub const STOP: u8 = 0x01;
pub const SPAWN: u8 = 0x02;
pub const WRITE: u8 = 0x03;
pub const RESIZE: u8 = 0x04;
pub const ALIVE: u8 = 0x05;
/// V2-1b (protocol 2): a reattaching core's first request; the answer is the agent and the holder's ring.
pub const ATTACH: u8 = 0x06;
// Holder to core: replies, then the output stream.
pub const SPAWNED: u8 = 0x80;
pub const OK: u8 = 0x81;
pub const ERR: u8 = 0x82;
pub const OUTPUT: u8 = 0x90;
pub const EOF: u8 = 0x91;

/// Magic, protocol version, oldest version this side still speaks.
pub fn hello() -> [u8; 12] {
    let mut out = [0; 12];
    out[..8].copy_from_slice(&MAGIC);
    out[8..10].copy_from_slice(&PROTOCOL.to_be_bytes());
    out[10..].copy_from_slice(&MIN_COMPATIBLE.to_be_bytes());
    out
}
/// The other side's (version, min-compatible), refused unless it is a holder hello.
pub fn read_hello(r: &mut impl Read) -> Result<(u16, u16), String> {
    let mut b = [0; 12];
    r.read_exact(&mut b)
        .map_err(|e| format!("holder hello: {e}"))?;
    if b[..8] != MAGIC {
        return Err("not a holder hello".into());
    }
    Ok((
        u16::from_be_bytes([b[8], b[9]]),
        u16::from_be_bytes([b[10], b[11]]),
    ))
}
/// Both sides speak a common version.
pub fn compatible((version, min): (u16, u16)) -> bool {
    version >= MIN_COMPATIBLE && min <= PROTOCOL
}
pub fn write_frame(w: &mut impl Write, op: u8, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len() + 1)
        .ok()
        .filter(|n| *n as usize <= MAX_FRAME)
        .ok_or_else(|| io::Error::other("holder frame too large"))?;
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.extend_from_slice(&len.to_be_bytes());
    frame.push(op);
    frame.extend_from_slice(payload);
    w.write_all(&frame)
}
/// One frame; its length is checked against `MAX_FRAME` before anything is allocated.
pub fn read_frame(r: &mut impl Read) -> io::Result<(u8, Vec<u8>)> {
    let mut len = [0; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(io::Error::other("invalid holder frame length"));
    }
    let mut op = [0; 1];
    r.read_exact(&mut op)?;
    let mut payload = vec![0; len - 1];
    r.read_exact(&mut payload)?;
    Ok((op[0], payload))
}

/// What a holder runs: argv, the whole environment, the folder, and the replay's starting bytes.
#[derive(Debug, PartialEq)]
pub struct Spawn {
    pub argv: Vec<Vec<u8>>,
    pub env: Vec<(Vec<u8>, Vec<u8>)>,
    pub cwd: Option<Vec<u8>>,
    pub seed: Vec<u8>,
}
impl Spawn {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = vec![];
        let put = |out: &mut Vec<u8>, b: &[u8]| {
            out.extend_from_slice(&(b.len() as u32).to_be_bytes());
            out.extend_from_slice(b);
        };
        out.extend_from_slice(&(self.argv.len() as u32).to_be_bytes());
        for a in &self.argv {
            put(&mut out, a);
        }
        out.extend_from_slice(&(self.env.len() as u32).to_be_bytes());
        for (k, v) in &self.env {
            put(&mut out, k);
            put(&mut out, v);
        }
        match &self.cwd {
            Some(cwd) => {
                out.push(1);
                put(&mut out, cwd);
            }
            None => out.push(0),
        }
        out.extend_from_slice(&self.seed);
        out
    }
    pub fn decode(mut b: &[u8]) -> Result<Self, String> {
        fn take<'a>(b: &mut &'a [u8], n: usize) -> Result<&'a [u8], String> {
            if b.len() < n {
                return Err("short spawn frame".into());
            }
            let (head, rest) = b.split_at(n);
            *b = rest;
            Ok(head)
        }
        fn count(b: &mut &[u8]) -> Result<usize, String> {
            let n = take(b, 4)?;
            Ok(u32::from_be_bytes([n[0], n[1], n[2], n[3]]) as usize)
        }
        fn bytes(b: &mut &[u8]) -> Result<Vec<u8>, String> {
            let n = count(b)?;
            Ok(take(b, n)?.to_vec())
        }
        // Each entry takes at least four bytes, so a count beyond the frame is refused before any allocation.
        let argc = count(&mut b)?;
        if argc == 0 || argc > b.len() / 4 {
            return Err("invalid spawn argv".into());
        }
        let argv = (0..argc).map(|_| bytes(&mut b)).collect::<Result<_, _>>()?;
        let envc = count(&mut b)?;
        if envc > b.len() / 8 {
            return Err("invalid spawn environment".into());
        }
        let env = (0..envc)
            .map(|_| Ok((bytes(&mut b)?, bytes(&mut b)?)))
            .collect::<Result<_, String>>()?;
        let cwd = match take(&mut b, 1)?[0] {
            0 => None,
            1 => Some(bytes(&mut b)?),
            _ => return Err("invalid spawn folder".into()),
        };
        Ok(Self {
            argv,
            env,
            cwd,
            seed: b.to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Golden bytes: these never change, whatever later versions add (a later core must read a 1.x holder's hello
    // and stop it).
    const HELLO_V1: [u8; 12] = [
        b'N', b'U', b'N', b'H', b'O', b'L', b'D', 0, 0x00, 0x01, 0x00, 0x01,
    ];
    const STOP_FRAME: [u8; 5] = [0x00, 0x00, 0x00, 0x01, 0x01];

    #[test]
    fn holder_first_frame_frozen() {
        // V2-1b: this build speaks protocol 2 in the same 12-byte layout and still reads a 1.x hello.
        assert_eq!(hello()[..8], HELLO_V1[..8]);
        assert_eq!(hello()[8..], [0x00, 0x02, 0x00, 0x01]);
        assert_eq!(read_hello(&mut &HELLO_V1[..]), Ok((1, 1)));
        assert!(compatible((1, 1)));
        let mut stop = vec![];
        write_frame(&mut stop, STOP, &[]).unwrap();
        assert_eq!(stop, STOP_FRAME);
        assert_eq!(read_frame(&mut &STOP_FRAME[..]).unwrap(), (STOP, vec![]));
        // A later holder (version 7, still speaking 2) is compatible; one that dropped 2 is not.
        assert!(compatible((7, 2)));
        assert!(!compatible((7, 3)));
        assert!(read_hello(&mut &b"HTTP/1.1 200"[..]).is_err());
    }

    #[test]
    fn frames_over_the_cap_are_refused_before_allocation() {
        let mut huge = ((MAX_FRAME + 1) as u32).to_be_bytes().to_vec();
        huge.push(WRITE);
        assert!(read_frame(&mut &huge[..]).is_err());
        assert!(read_frame(&mut &[0u8, 0, 0, 0][..]).is_err());
        assert!(write_frame(&mut vec![], WRITE, &vec![0; MAX_FRAME]).is_err());
    }

    #[test]
    fn spawn_round_trips_and_refuses_truncation() {
        let spawn = Spawn {
            argv: vec![b"/bin/sh".to_vec(), b"-c".to_vec(), vec![0xff, b'x']],
            env: vec![(b"TERM".to_vec(), b"xterm-256color".to_vec())],
            cwd: Some(b"/tmp".to_vec()),
            seed: b"old screen".to_vec(),
        };
        let bytes = spawn.encode();
        assert_eq!(Spawn::decode(&bytes).unwrap(), spawn);
        for cut in [0, 3, 4, 10, 20] {
            assert!(Spawn::decode(&bytes[..cut]).is_err(), "cut at {cut}");
        }
        let mut lying = bytes.clone();
        lying[..4].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(Spawn::decode(&lying).is_err());
    }
}
