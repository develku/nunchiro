//! Ticket 573 slice 3: `nunchiro token create|list|revoke`, the owner's tokens for outside callers.
use nunchiro_core::{api::*, tokens};
use std::path::{Path, PathBuf};

pub fn run(home: &Path, args: &[String]) -> Result<(), String> {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    match words.as_slice() {
        ["create", rest @ ..] => {
            let (mut scope, mut project, mut expires) = (None, None, None);
            let mut i = 0;
            while i < rest.len() {
                let value = rest.get(i + 1).ok_or("missing token option value")?;
                match rest[i] {
                    "--scope" => scope = Some(value.parse::<tokens::Scope>()?),
                    "--project" => {
                        project =
                            Some(std::path::absolute(value).map_err(|e| e.to_string())?)
                                as Option<PathBuf>
                    }
                    "--expires" => expires = Some(tokens::parse_expires(value)?),
                    _ => return Err("unknown token option".into()),
                }
                i += 2;
            }
            super::ensure_core(home)?;
            let Reply::TokenCreated { token, secret } = super::call(
                home,
                Request::TokenCreate {
                    scope: scope.ok_or("--scope read|supervised|full|trigger is required")?,
                    project,
                    expires_in_ms: expires,
                },
            )?
            else {
                return Err("invalid token reply".into());
            };
            // The secret alone on stdout, so `NUNCHIRO_TOKEN=$(nunchiro token create ...)` works; it is not kept.
            eprintln!(
                "token {}: shown once; Nunchiro keeps only its hash",
                token.id
            );
            println!("{secret}");
            Ok(())
        }
        ["list", flags @ ..] if flags.iter().all(|f| *f == "--json") => {
            super::ensure_core(home)?;
            let Reply::Tokens { tokens } = super::call(home, Request::TokenList)? else {
                return Err("invalid token reply".into());
            };
            if !flags.is_empty() {
                println!(
                    "{}",
                    serde_json::to_string(&tokens).map_err(|e| e.to_string())?
                );
                return Ok(());
            }
            for t in tokens {
                let scope = serde_json::to_value(t.scope).map_err(|e| e.to_string())?;
                let project = t.project.as_deref().map_or("-".into(), Path::to_string_lossy);
                let expires = t.expires_ms.map_or("-".into(), |e| e.to_string());
                println!(
                    "{}\t{}\t{}\t{}",
                    t.id,
                    scope.as_str().unwrap_or(""),
                    project,
                    expires
                );
            }
            Ok(())
        }
        ["revoke", id] => {
            super::ensure_core(home)?;
            super::call(home, Request::TokenRevoke { id: (*id).into() })?;
            Ok(())
        }
        _ => Err("usage: nunchiro token create --scope read|supervised|full [--project DIR] [--expires 30m|12h|7d] | list [--json] | revoke ID".into()),
    }
}
