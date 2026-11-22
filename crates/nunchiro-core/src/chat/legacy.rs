//! Streaming upgrade of the original JSON cache, without retaining its history in RAM.
use super::{
    Event,
    log::Log,
    persistence::{State, StopSlot, Stops},
};
use crate::store;
use serde::{
    Deserialize,
    de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap, fmt, fs::OpenOptions, io::BufReader, os::unix::fs::OpenOptionsExt,
    path::Path, sync::Arc,
};
fn input(path: &Path) -> Result<BufReader<std::fs::File>, String> {
    let f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| e.to_string())?;
    if !f.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("invalid chat cache file".into());
    }
    Ok(BufReader::new(f))
}
pub fn version(path: &Path) -> Result<u32, String> {
    struct Header;
    impl<'de> Visitor<'de> for Header {
        type Value = u32;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("chat object")
        }
        fn visit_map<M: MapAccess<'de>>(self, mut m: M) -> Result<u32, M::Error> {
            let mut version = None;
            while let Some(k) = m.next_key::<String>()? {
                if k == "version" {
                    if version.is_some() {
                        return Err(de::Error::custom("duplicate chat version"));
                    }
                    version = Some(m.next_value()?);
                } else {
                    m.next_value::<IgnoredAny>()?;
                }
            }
            version.ok_or_else(|| de::Error::custom("missing chat version"))
        }
    }
    use serde::Deserializer;
    serde_json::Deserializer::from_reader(input(path)?)
        .deserialize_map(Header)
        .map_err(|e| e.to_string())
}
struct Records<'a> {
    log: &'a mut Log,
    finals: bool,
    feed: bool,
}
impl<'de> DeserializeSeed<'de> for Records<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        if self.feed {
            d.deserialize_map(self)
        } else {
            d.deserialize_seq(self)
        }
    }
}
impl<'de> Visitor<'de> for Records<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("chat records")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<(), M::Error> {
        let mut seen = false;
        while let Some(k) = map.next_key::<String>()? {
            if k == "events" && !seen {
                seen = true;
                map.next_value_seed(Records {
                    log: self.log,
                    finals: false,
                    feed: false,
                })?;
            } else {
                return Err(de::Error::custom("invalid legacy feed"));
            }
        }
        if !seen {
            return Err(de::Error::custom("missing legacy events"));
        }
        Ok(())
    }
    fn visit_seq<S: SeqAccess<'de>>(self, mut seq: S) -> Result<(), S::Error> {
        let mut values = vec![];
        let mut size = 0;
        let mut count = 0;
        while let Some(value) = seq.next_element::<Value>()? {
            let value = if self.finals {
                let (turn, text): (String, String) =
                    serde_json::from_value(value).map_err(de::Error::custom)?;
                if turn.is_empty() {
                    return Err(de::Error::custom("missing final turn"));
                }
                let mut duplicate = false;
                self.log
                    .each(|e| {
                        duplicate |= e.data["turn_id"] == turn;
                        Ok(())
                    })
                    .map_err(de::Error::custom)?;
                if duplicate || values.iter().any(|e: &Value| e["turn_id"] == turn) {
                    return Err(de::Error::custom("duplicate final turn"));
                }
                json!({"kind":"final_text","turn_id":turn,"text":text})
            } else {
                let e: Event = serde_json::from_value(value).map_err(de::Error::custom)?;
                count += 1;
                if e.schema_version != 1 || e.cursor != count || !super::valid_data(&e.data) {
                    return Err(de::Error::custom("invalid legacy event"));
                }
                e.data
            };
            size += serde_json::to_vec(&value).map_err(de::Error::custom)?.len();
            values.push(value);
            if size >= 256 * 1024 {
                self.log
                    .append(values.drain(..))
                    .map_err(de::Error::custom)?;
                size = 0;
            }
        }
        if !values.is_empty() {
            self.log.append(values).map_err(de::Error::custom)?;
        }
        Ok(())
    }
}
pub fn migrate(dir: &Path, id: &str, path: &Path, stops: &Arc<StopSlot>) -> Result<State, String> {
    let mut events = Log::fresh(dir)?;
    let mut finals = Log::fresh(dir)?;
    struct Upgrade<'a> {
        events: &'a mut Log,
        finals: &'a mut Log,
    }
    impl<'de> Visitor<'de> for Upgrade<'_> {
        type Value = BTreeMap<String, Value>;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("legacy chat object")
        }
        fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
            let mut fields = BTreeMap::new();
            let mut feed = false;
            let mut finals = false;
            while let Some(k) = map.next_key::<String>()? {
                match k.as_str() {
                    "feed" if !feed => {
                        feed = true;
                        map.next_value_seed(Records {
                            log: self.events,
                            finals: false,
                            feed: true,
                        })?;
                    }
                    "finals" if !finals => {
                        finals = true;
                        map.next_value_seed(Records {
                            log: self.finals,
                            finals: true,
                            feed: false,
                        })?;
                    }
                    "feed" | "finals" => {
                        return Err(de::Error::custom("duplicate legacy history field"));
                    }
                    _ => {
                        if fields.insert(k, map.next_value()?).is_some() {
                            return Err(de::Error::custom("duplicate chat field"));
                        }
                    }
                }
            }
            if !feed || !finals {
                return Err(de::Error::custom("missing legacy history"));
            }
            Ok(fields)
        }
    }
    let result = (|| {
        use serde::Deserializer;
        let mut de = serde_json::Deserializer::from_reader(input(path)?);
        let mut fields = de
            .deserialize_map(Upgrade {
                events: &mut events,
                finals: &mut finals,
            })
            .map_err(|e| e.to_string())?;
        de.end().map_err(|e| e.to_string())?;
        #[derive(Deserialize)]
        struct Meta {
            version: u32,
            key: String,
            offset: u64,
            discarding: bool,
        }
        let meta: Meta =
            serde_json::from_value(serde_json::to_value(&fields).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if meta.version != 1 || meta.key.is_empty() && (meta.offset != 0 || meta.discarding) {
            return Err("invalid legacy metadata".into());
        }
        for k in ["version", "key", "offset", "discarding"] {
            fields.remove(k);
        }
        if ["generation", "fingerprint", "events", "skipped"]
            .iter()
            .any(|k| fields.contains_key(*k))
        {
            return Err("legacy extension conflicts with new metadata".into());
        }
        if serde_json::to_vec(&fields)
            .map_err(|e| e.to_string())?
            .len()
            > 16 * 1024
        {
            return Err("oversized legacy extension metadata".into());
        }
        let mut skipped = 0;
        events.each(|e| {
            if e.data["kind"] == "skipped" {
                skipped += e.data["count"].as_u64().unwrap_or(0);
            }
            Ok(())
        })?;
        let mut guard = stops.value.lock().map_err(|_| "Stop store unavailable")?;
        if guard.is_none() {
            *guard = Some(Stops::open(dir, id)?);
        }
        let stop = guard.as_mut().unwrap();
        finals.each(|e| {
            stop.append(
                e.data["turn_id"].as_str().unwrap(),
                e.data["text"].as_str().unwrap(),
            )
        })?;
        let state = State {
            version: 2,
            generation: 1,
            key: meta.key,
            offset: meta.offset,
            discarding: meta.discarding,
            fingerprint: None,
            events: events.position.clone(),
            skipped,
            extra: fields,
        };
        store::atomic_write(
            path,
            &serde_json::to_vec(&state).map_err(|e| e.to_string())?,
        )?;
        Ok(state)
    })();
    finals.remove();
    if result.is_err() {
        events.remove();
    }
    result
}
