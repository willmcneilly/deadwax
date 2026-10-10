//! Time, behind a trait, so tests can run on a fake clock instead of
//! waiting for real seconds to pass.

use std::future::Future;
use std::time::{Duration, SystemTime};

pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> SystemTime;
    fn sleep(&self, duration: Duration) -> impl Future<Output = ()> + Send;
}

/// The real clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// A clock that only moves when something sleeps on it. Each sleep is
    /// written to the shared log, so a test can see what happened in what
    /// order.
    #[derive(Clone)]
    pub struct FakeClock {
        now: Arc<Mutex<SystemTime>>,
        pub log: Arc<Mutex<Vec<String>>>,
    }

    impl FakeClock {
        pub fn new(log: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                now: Arc::new(Mutex::new(
                    SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000),
                )),
                log,
            }
        }

        pub fn advance(&self, duration: Duration) {
            *self.now.lock().unwrap() += duration;
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> SystemTime {
            *self.now.lock().unwrap()
        }

        async fn sleep(&self, duration: Duration) {
            self.log
                .lock()
                .unwrap()
                .push(format!("sleep {}s", duration.as_secs_f64()));
            self.advance(duration);
        }
    }
}
