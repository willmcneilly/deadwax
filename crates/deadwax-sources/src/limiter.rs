//! Spacing requests out, for services that ask for no more than so many a
//! minute: iTunes about 20, MusicBrainz one a second (RFC-001, "High-res
//! artwork, as an experiment").

use std::time::{Duration, SystemTime};

use tokio::sync::Mutex;

use crate::clock::Clock;

/// Lets one request through at a time, at least `interval` after the last.
/// Callers that arrive together queue up and go in turn.
pub struct Limiter<C> {
    clock: C,
    interval: Duration,
    /// When the last request went. Held while waiting, which is the queue.
    last: Mutex<Option<SystemTime>>,
}

impl<C: Clock> Limiter<C> {
    pub fn new(clock: C, interval: Duration) -> Self {
        Self {
            clock,
            interval,
            last: Mutex::new(None),
        }
    }

    /// Waits until a request may go, and counts it as gone.
    pub async fn wait(&self) {
        let mut last = self.last.lock().await;
        if let Some(at) = *last
            && let Ok(wait) = (at + self.interval).duration_since(self.clock.now())
            && !wait.is_zero()
        {
            self.clock.sleep(wait).await;
        }
        *last = Some(self.clock.now());
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::clock::fake::FakeClock;

    #[tokio::test]
    async fn the_first_request_goes_straight_away_and_the_next_waits_its_turn() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let clock = FakeClock::new(log.clone());
        let limiter = Limiter::new(clock.clone(), Duration::from_secs(3));

        limiter.wait().await;
        limiter.wait().await;
        clock.advance(Duration::from_secs(1));
        limiter.wait().await;
        clock.advance(Duration::from_secs(10));
        limiter.wait().await;

        assert_eq!(*log.lock().unwrap(), ["sleep 3s", "sleep 2s"]);
    }
}
