"""Send test events to Sentry to verify backend configuration."""

from __future__ import annotations

from backend.utils.config import load_settings  # noqa: F401 - loads .env
from backend.utils.sentry import capture_exception, init_sentry


def main() -> None:
    if not init_sentry("conjure-backend-verify"):
        raise SystemExit(
            "Sentry is not configured. Set SENTRY_DSN in .env and try again."
        )

    import sentry_sdk
    from sentry_sdk import metrics

    sentry_sdk.logger.info("conjure sentry verify: info log")
    sentry_sdk.logger.warning("conjure sentry verify: warning log")

    metrics.count("conjure.verify.checkout_failed", 1)
    metrics.gauge("conjure.verify.queue_depth", 42)
    metrics.distribution("conjure.verify.cart_amount_usd", 187.5)

    try:
        _ = 1 / 0
    except ZeroDivisionError as exc:
        capture_exception(exc)

    print("Sent test log, metric, and error events to Sentry.")
    print("Check your Sentry project dashboard in a few seconds.")


if __name__ == "__main__":
    main()
