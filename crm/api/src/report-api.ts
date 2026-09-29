import type { FastifyInstance } from 'fastify';
import { DomainError, type Actor } from './domain.js';
import { readyReports, ReportService } from './report-service.js';
import { REPORT_EXPORT_COLUMNS } from './report-columns.js';

const uuid = { type: 'string', format: 'uuid' };
const privateNoStoreHeader = { 'Cache-Control': { description: 'Authenticated report data is not cached after access changes.', schema: { type: 'string', enum: ['private, no-store'] } } };
const reportFilterSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' },
    kind: { type: 'string', enum: ['university', 'corporate', 'individual'] }, ownerSub: { type: 'string', minLength: 1, maxLength: 255 }, organizationId: uuid,
    productId: uuid, programId: { ...uuid, description: 'Активности, связанные с выбранной учебной программой; учебные факты относятся к активности целиком и не распределяются между программами.' }, learningFactKind: { type: 'string', enum: ['enrollment','learning_started','learning_completed'] }, requestedPlacesRecorded: { type: 'boolean', description: 'Chart drilldown filter for whether the corporate plan records a requested-place value.' }, includeClosed: { type: 'boolean', default: true },
  },
};
const reportExportColumnsSchema = {
  type: 'array', minItems: 1, maxItems: REPORT_EXPORT_COLUMNS.length, uniqueItems: true,
  items: { type: 'string', enum: REPORT_EXPORT_COLUMNS.map((column) => column.key) },
};

export const reportOpenApiPaths = {
  '/api/reports/ready': { get: { summary: 'Готовые CRM отчёты и определения их источников', responses: { '200': { description: 'Портфель CRM, спрос/факты обучения и allowlist колонок выгрузки', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', required: ['id', 'title', 'exportColumns'], properties: { id: { type: 'string', enum: ['crm_portfolio', 'demand_learning'] }, title: { type: 'string' }, exportColumns: { type: 'array', items: { type: 'object', required: ['key', 'label'], properties: { key: { type: 'string', enum: REPORT_EXPORT_COLUMNS.map((column) => column.key) }, label: { type: 'string' } } } } } } } } }, headers: privateNoStoreHeader } } } },
  '/api/reports/owners': { get: {
    summary: 'Ответственные для фильтра отчётов руководителя',
    description: 'Только руководитель. Возвращает ответственных, присутствующих в разрешённой области отчётов, включая закрытые активности. Названия берутся из самой свежей видимой активности каждого ответственного.',
    responses: {
      '200': {
        description: 'Ответственные, видимые в отчётах с текущей областью доступа',
        content: { 'application/json': { schema: {
          type: 'array', items: { type: 'object', required: ['ownerSub', 'ownerName'], properties: { ownerSub: { type: 'string' }, ownerName: { type: 'string' } } },
        } } },
        headers: privateNoStoreHeader,
      },
      '403': { description: 'Нужна бизнес-роль руководителя' },
    },
  } },
  '/api/reports/organizations': { get: {
    summary: 'Организации для фильтра отчётов руководителя',
    description: 'Только руководитель. Возвращает организации, связанные с активностями в разрешённой области отчётов; имена из других областей доступа не раскрываются.',
    responses: {
      '200': {
        description: 'Организации, видимые в отчётах с текущей областью доступа',
        content: { 'application/json': { schema: {
          type: 'array', items: { type: 'object', required: ['organizationId', 'organizationName'], properties: { organizationId: uuid, organizationName: { type: 'string' } } },
        } } },
        headers: privateNoStoreHeader,
      },
      '403': { description: 'Нужна бизнес-роль руководителя' },
    },
  } },
  '/api/reports/snapshots': { post: {
    summary: 'Построить полный разрешённый срез отчёта', description: 'Сохраняет as-of snapshot для согласования фильтров, метрик, графика, исходных строк и последующих экспортов. Все подходящие строки включены, независимо от страницы UI.',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['reportId'], properties: { reportId: { type: 'string', enum: ['crm_portfolio', 'demand_learning'] }, filters: reportFilterSchema } } } } },
    responses: { '201': { description: 'Метрики, series графика, total rowCount и первая страница исходных строк на дату asOf; полный срез хранится в PostgreSQL', headers: privateNoStoreHeader }, '403': { description: 'Запрещённый фильтр или изменившаяся область доступа' },
  } } },
  '/api/reports/snapshots/{id}': { get: { summary: 'Прочитать страницу сохранённого среза с текущей проверкой области доступа', parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }, { name: 'page', in: 'query', required: false, schema: { type: 'string', pattern: '^[1-9][0-9]*$', default: '1' }, description: 'Номер страницы из результата rowCount; размер страницы возвращается в pageSize.' }], responses: { '200': { description: 'Метаданные полного среза и одна страница source records; productLinks и programLinks сохраняют ID и названия на момент среза, а export использует все сохранённые строки', headers: privateNoStoreHeader }, '400': { description: 'Номер страницы некорректен или выходит за конец среза' }, '403': { description: 'Область данных или назначение изменились' }, '404': { description: 'Срез не найден или истёк' } } } },
  '/api/reports/exports': { get: {
    summary: 'Список последних заданий экспорта текущего пользователя',
    parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 20, default: 20 } }],
    responses: { '200': { description: 'До 20 заданий в порядке от новых к старым; недоступные по текущей области и истёкшие задания не включаются', headers: privateNoStoreHeader }, '400': { description: 'Лимит вне диапазона от 1 до 20' }, '403': { description: 'Текущая роль не разрешает доступ к отчётам' } },
  }, post: {
    summary: 'Поставить фоновое задание XLS/XLSX/CSV/PDF/JSON/PNG', description: 'Задание использует полный сохранённый snapshot. CSV содержит все строки данных этого среза и выбранные колонки. По умолчанию JSON также содержит связи записи с организацией, человеком, плательщиком, продуктами, учебными программами, документами и договорным контекстом по ID; приватные ключи файлов не выдаются. Выбранные колонки сокращают строки XLS/XLSX/CSV, PDF-отчёта и JSON; метрики и график остаются полными. Если список не передан, используются все колонки.',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['snapshotId', 'format'], properties: { snapshotId: uuid, format: { type: 'string', enum: ['xls','xlsx','csv','pdf','json','png','chart-pdf'] }, chartId: { type: 'string', description: 'Для PNG/PDF графика выбирает график из snapshot; XLS/XLSX/CSV/PDF отчёта/JSON игнорируют этот параметр.' }, columns: { ...reportExportColumnsSchema, description: 'Уникальные ключи из GET /api/reports/ready.exportColumns. Пустой список запрещён; без поля используются все колонки.' } } } } } },
    responses: { '202': { description: 'Фоновое задание экспорта создано', headers: privateNoStoreHeader }, '400': { description: 'Неизвестный, повторяющийся или пустой набор колонок' }, '403': { description: 'Текущий доступ не покрывает весь сохранённый срез' }, '404': { description: 'Срез не найден или истёк' }, '413': { description: 'Число строк превышает предел листа XLS/XLSX или объём исходного набора превышает безопасный предел; данные не обрезаются' } },
  } },
  '/api/reports/exports/{id}': { get: { summary: 'Статус фонового экспорта с текущей проверкой области доступа', parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }], responses: { '200': { description: 'Очередь, успех, ошибка и срок хранения', headers: privateNoStoreHeader }, '403': { description: 'Область данных или назначение изменились' }, '404': { description: 'Задание не найдено или истекло' } } } },
  '/api/reports/exports/{id}/file': { get: { summary: 'Скачать приватный файл после повторной проверки роли, области и целостности', parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }], responses: { '200': { description: 'Настоящий XLS/XLSX/CSV/PDF/JSON/PNG файл', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }, headers: { ...privateNoStoreHeader, 'Content-Disposition': { schema: { type: 'string' } }, 'X-Content-Type-Options': { schema: { type: 'string', enum: ['nosniff'] } } } }, '403': { description: 'Область данных или назначение изменились' }, '409': { description: 'Экспорт ещё не готов или завершился ошибкой' }, '410': { description: 'Файл отсутствует или повреждён' } } } },
};

export function registerReportRoutes(app: FastifyInstance, service = new ReportService()) {
  app.get('/api/reports/ready', async (_request, reply) => reply.header('Cache-Control', 'private, no-store').send(readyReports));
  app.get('/api/reports/owners', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return service.listOwners(request.actor as Actor);
  });
  app.get('/api/reports/organizations', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return service.listOrganizations(request.actor as Actor);
  });
  app.post<{ Body: { reportId: string; filters?: Record<string, unknown> } }>('/api/reports/snapshots', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['reportId'], properties: {
      reportId: { type: 'string', enum: ['crm_portfolio', 'demand_learning'] }, filters: reportFilterSchema,
    } } },
  }, async (request, reply) => reply.header('Cache-Control', 'private, no-store').code(201).send(await service.createSnapshot(request.actor as Actor, request.body)));
  app.get<{ Params: { id: string }; Querystring: { page?: string } }>('/api/reports/snapshots/:id', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: uuid } },
      querystring: { type: 'object', additionalProperties: false, properties: { page: { type: 'string', pattern: '^[1-9][0-9]*$' } } },
    },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return service.getSnapshot(request.actor as Actor, request.params.id, request.query.page);
  });
  app.post<{ Body: { snapshotId: string; format: string; chartId?: string; columns?: string[] } }>('/api/reports/exports', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['snapshotId', 'format'], properties: { snapshotId: uuid, format: { type: 'string', enum: ['xls','xlsx','csv','pdf','json','png','chart-pdf'] }, chartId: { type: 'string', maxLength: 100 }, columns: reportExportColumnsSchema } } },
  }, async (request, reply) => reply.header('Cache-Control', 'private, no-store').code(202).send(await service.createExport(request.actor as Actor, request.body.snapshotId, request.body.format, request.body.chartId, request.body.columns)));
  app.get<{ Querystring: { limit?: number } }>('/api/reports/exports', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 20, default: 20 } } } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return service.listExports(request.actor as Actor, request.query.limit);
  });
  app.get<{ Params: { id: string } }>('/api/reports/exports/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return service.getExportStatus(request.actor as Actor, request.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/reports/exports/:id/file', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const file = await service.downloadExport(request.actor as Actor, request.params.id);
    const dispositionName = encodeURIComponent(file.fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return reply.type(file.mediaType).header('Content-Disposition', `attachment; filename*=UTF-8''${dispositionName}`)
      .header('X-Content-Type-Options', 'nosniff').send(file.bytes);
  });
}
