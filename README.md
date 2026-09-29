# РТК CRM · ИТ Школа Ростелекома

CRM для работы с вузами, компаниями и заявками на индивидуальное обучение. В карточке собраны этап, ответственный, задачи и история общения.

## Посмотреть решение

- [CRM](https://crm.futura.team/) · [форма заявки](https://crm.futura.team/request/)
- [Документация](Documentation/RTK_CRM_Guide.pdf) · [презентация](Presentation/RTK_CRM_LCT2026.pdf) · [макеты Figma](https://www.figma.com/design/kTMqGGpBwiPckoJk5VxCBo?node-id=145-1210)

Начните с очереди и карточки КАМ. Затем откройте показатели и отчёты руководителя. Для новой заявки используйте форму.

## Вход на публичный стенд

| Роль | Логин | Пароль |
| --- | --- | --- |
| КАМ | `kam.anna` | `pVp8TzOG2Rhemmyq7A3vewV8G5LI5UKk06Dc9Ezc1dE` |
| Второй КАМ | `kam.dmitry` | `C_cMfLMxrlHUEdIrRlMMYCIn1WttCOhdBCnfx4wF_go` |
| КАМ | `kam.polina` | `C-Xw64F13fJhRXKn_5OL-Vb-NZwZMiwgynDejtY5iHQ` |
| Руководитель | `manager` | `hKQqd4wTzS7gHLw81hyXftr0a7Rg1kISuBhPJ8QvAsE` |
| Администратор | `admin` | `dOsqu741Nq5YT5ew1u1G4qwO-7dMBXY4kFYaRM3xcrU` |

Стенд общий. Для проверки создавайте новые заявки; не меняйте общую схему и права других пользователей.

## Локальный запуск

Нужны Docker Compose, Node.js 22+, npm и OpenSSL. На macOS или Linux:

```bash
cd crm
./run-local.sh
```

CRM откроется на `http://localhost:5173`, API — на `http://localhost:3001/docs`. Локальные логины те же; пароли скрипт создаст в `crm/.env.local` (`KAM_ANNA_PASSWORD`, `KAM_DMITRY_PASSWORD`, `MANAGER_PASSWORD`, `LOCAL_ADMIN_PASSWORD`). Остановка — `Ctrl+C`. Подробности — в [инструкции по запуску](crm/README.md#запуск).

Внешние CMS и LMS заменены тестовыми сервисами; обмены с системами заказчика не выполняются. Исходный код и техническая документация находятся в [`crm/`](crm/README.md).
