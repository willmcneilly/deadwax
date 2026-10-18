//! The last few search replies from iTunes and MusicBrainz, kept for a
//! while, so a later step for the same album reuses the artwork lookup's
//! request instead of asking again (RFC-002, "3. Genre and label"). The
//! album job queue runs one album's steps back to back, so the genre and
//! label step finds the lookup's iTunes reply here.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

/// How many replies are kept: one album's lookup makes a handful.
const KEEP: usize = 8;

/// How long a reply is reused. Long enough for an album's steps, which
/// include downloading its cover; short enough that a retry later asks
/// afresh.
pub const FRESH_FOR: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct Replies {
    /// Each reply's URL, when it came and its body, the newest last.
    kept: Mutex<VecDeque<(String, SystemTime, Vec<u8>)>>,
}

impl Replies {
    /// The body of the reply to `url`, if one came less than `FRESH_FOR`
    /// before `now`.
    pub fn get(&self, url: &str, now: SystemTime) -> Option<Vec<u8>> {
        let kept = self.kept.lock().expect("replies lock");
        kept.iter()
            .rev()
            .find(|(kept_url, at, _)| {
                kept_url == url && now.duration_since(*at).is_ok_and(|age| age < FRESH_FOR)
            })
            .map(|(_, _, body)| body.clone())
    }

    /// Keeps the reply to `url`, which came at `now`.
    pub fn put(&self, url: String, now: SystemTime, body: Vec<u8>) {
        let mut kept = self.kept.lock().expect("replies lock");
        kept.retain(|(kept_url, _, _)| *kept_url != url);
        kept.push_back((url, now, body));
        while kept.len() > KEEP {
            kept.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000 + seconds)
    }

    #[test]
    fn a_reply_is_reused_while_its_fresh() {
        let replies = Replies::default();
        replies.put("https://a".into(), at(0), b"one".to_vec());

        assert_eq!(replies.get("https://a", at(0)), Some(b"one".to_vec()));
        assert_eq!(
            replies.get("https://a", at(FRESH_FOR.as_secs() - 1)),
            Some(b"one".to_vec())
        );
        assert_eq!(replies.get("https://a", at(FRESH_FOR.as_secs())), None);
        assert_eq!(replies.get("https://b", at(0)), None);
    }

    #[test]
    fn a_newer_reply_to_the_same_url_replaces_the_old() {
        let replies = Replies::default();
        replies.put("https://a".into(), at(0), b"old".to_vec());
        replies.put("https://a".into(), at(5), b"new".to_vec());

        assert_eq!(replies.get("https://a", at(6)), Some(b"new".to_vec()));
        assert_eq!(replies.kept.lock().unwrap().len(), 1);
    }

    #[test]
    fn only_the_last_few_are_kept() {
        let replies = Replies::default();
        for i in 0..=KEEP {
            replies.put(format!("https://{i}"), at(0), Vec::new());
        }

        assert_eq!(replies.get("https://0", at(0)), None);
        assert!(replies.get(&format!("https://{KEEP}"), at(0)).is_some());
    }
}
