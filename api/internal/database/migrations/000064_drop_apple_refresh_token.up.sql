-- Kora signs users in through Zitadel, which brokers Sign in with Apple, so the
-- app never sees an Apple authorization code and has nothing to exchange.
-- Revoking Apple grants on account deletion moves to the platform
-- (tesserix/tesserix-k8s#1388). The tester accounts that held tokens are wiped
-- before cutover through the deletion path, which revokes them.
ALTER TABLE users DROP COLUMN apple_refresh_token;
