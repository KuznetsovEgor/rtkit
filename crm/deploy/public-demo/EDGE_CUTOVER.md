# Бесплатный HTTPS-фронт Cloudflare при сохранении сайта на Railway

Статус: **вариант, не переключён**. В проверенном VPN прямой HTTPS к VPS сбрасывается; Cloudflare edge и временный Cloudflare Tunnel до VPS ответили HTTP 200. Основной `futura.team` через Railway также ответил 200. CRM через постоянный Cloudflare hostname ещё не проверена.

## Ограничения бесплатного плана

Cloudflare Free требует **full DNS setup**: в Namecheap меняются NS всего `futura.team`. Хостинг сайта от этого не переезжает: в новой DNS-зоне `@` и `www` остаются направлены на прежний Railway, в режиме DNS only. Бесплатный partial/CNAME setup, оставляющий Namecheap авторитетным DNS, недоступен.

Free Universal SSL при full setup покрывает `futura.team` и первый уровень (`crm.futura.team`), но **не** `api.crm.futura.team` и `auth.crm.futura.team`. Для бесплатного варианта нужно переименовать API и вход, например в `crm-api.futura.team` и `crm-auth.futura.team`, и синхронно обновить frontend build, Caddy, Keycloak public hostname/redirect и документацию. Прежние вложенные адреса нельзя проксировать без подходящего edge-сертификата.

Публично видны пять Namecheap MX `eforward*.registrar-servers.com` и SPF TXT. Namecheap указывает, что его бесплатная Email Forwarding доступна только с их NS. Если пересылка реально используется, до смены NS нужен отдельный план миграции почты (например, Cloudflare Email Routing), иначе можно прервать доставку. Простой перенос MX не следует считать достаточным.

## Порядок без простоя основного сайта

1. Экспортировать **полную** DNS-зону Namecheap, выяснить использование email forwarding и DNSSEC.
2. Добавить `futura.team` в Cloudflare Free; до смены NS вручную проверить `@`/`www` Railway, MX/TXT/verification-записи и три CRM A-записи. `@`/`www` — DNS only; CRM — Proxied. Не менять действующие Railway deployments.
3. Подготовить CRM на новых плоских адресах и проверить origin TLS/Keycloak callback. При необходимости сначала выпустить сертификаты для новых адресов на VPS, пока DNS ещё у Namecheap.
4. После проверки записей поменять NS в Namecheap на выданные Cloudflare. Дождаться активной зоны и сертификатов.
5. Проверить в браузере с VPN и без VPN сайт `futura.team`, три CRM HTTPS-адреса, полный вход и повторный вход, мобильный сценарий и используемую почту.

Источники: [Cloudflare full setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/), [Free/Pro не поддерживают partial setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/), [ограничение Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/), [Namecheap Free Email Forwarding](https://www.namecheap.com/support/knowledgebase/article.aspx/308/2214/how-to-set-up-free-email-forwarding/).
