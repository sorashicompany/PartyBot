# PartyGame2 source import

This directory is a faithful source snapshot of sorashicompany/partygame2.
Generated output, installed dependencies, Git metadata, and Grok workspace
metadata are excluded. Application source, assets, scripts, migrations,
tests, and lockfiles are retained.

The root application remains the Telegram Mini App running on Cloudflare
Workers. The imported app source is retained here for complete provenance;
runtime-specific auth and data adapters must be reviewed before replacing
the root application. Never expose Supabase service-role credentials to
the browser. Telegram Mini App identity must be verified server-side from
Telegram.WebApp.initData.
