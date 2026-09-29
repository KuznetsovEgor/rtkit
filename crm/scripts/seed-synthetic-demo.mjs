#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO_DATABASE = 'lctcrm_demo';
export const DEMO_MARKER = 'lct CRM synthetic_demo isolated database v1';
const LOCAL_HOST = '127.0.0.1';
const LOCAL_PORT = 54329;
const DB_USER = 'lctcrm';
const SEED_SOURCE = 'synthetic-demo-seed-v1';

const users = [
  { sub: '10000000-0000-4000-8000-000000000001', username: 'kam.anna', name: 'Анна Орлова', roles: ['kam'] },
  { sub: '10000000-0000-4000-8000-000000000002', username: 'kam.dmitry', name: 'Дмитрий Соколов', roles: ['kam'] },
  { sub: '10000000-0000-4000-8000-000000000003', username: 'manager', name: 'Елена Руководитель', roles: ['manager'] },
  { sub: '10000000-0000-4000-8000-000000000004', username: 'admin', name: 'Алексей Администратор', roles: ['admin'] },
];

const priorSeedUsers = [
  { sub: 'synthetic-demo:kam', username: users[0].username },
  { sub: 'synthetic-demo:manager', username: users[2].username },
  { sub: 'synthetic-demo:admin', username: users[3].username },
];

const organizations = [
  { id: 'a1000000-0000-4000-8000-000000000001', name: 'Северо-Западный технологический университет', segment: 'university', createdAt: '2026-09-01T09:00:00.000Z' },
  { id: 'a1000000-0000-4000-8000-000000000002', name: 'ООО «Геоаналитика»', segment: 'company', createdAt: '2026-09-01T09:05:00.000Z' },
  { id: 'a1000000-0000-4000-8000-000000000003', name: 'Колледж информационных технологий «Вектор»', segment: 'university', createdAt: '2026-09-01T09:25:00.000Z' },
  { id: 'a1000000-0000-4000-8000-000000000004', name: 'АО «ПромСфера»', segment: 'company', createdAt: '2026-09-01T09:30:00.000Z' },
];

const people = [
  { id: 'a2000000-0000-4000-8000-000000000001', fullName: 'Ирина Павлова', organizationName: organizations[0].name, createdAt: '2026-09-01T09:10:00.000Z' },
  { id: 'a2000000-0000-4000-8000-000000000002', fullName: 'Вера Кузнецова', organizationName: organizations[1].name, createdAt: '2026-09-01T09:15:00.000Z' },
  { id: 'a2000000-0000-4000-8000-000000000003', fullName: 'Мира Левина', organizationName: null, createdAt: '2026-09-01T09:20:00.000Z' },
  { id: 'a2000000-0000-4000-8000-000000000004', fullName: 'Надежда Сорокина', organizationName: organizations[2].name, createdAt: '2026-09-01T09:35:00.000Z' },
  { id: 'a2000000-0000-4000-8000-000000000005', fullName: 'Кирилл Фомин', organizationName: organizations[3].name, createdAt: '2026-09-01T09:40:00.000Z' },
  { id: 'a2000000-0000-4000-8000-000000000006', fullName: 'Олеся Ветрова', organizationName: null, createdAt: '2026-09-01T09:45:00.000Z' },
  { id: 'a2000000-0000-4000-8000-000000000007', fullName: 'Тимур Егоров', organizationName: null, createdAt: '2026-09-01T09:50:00.000Z' },
];

const activities = [
  // Keep the original three seed rows unchanged so an already-created v1 demo database can be upgraded additively.
  {
    id: 'a3000000-0000-4000-8000-000000000001', kind: 'university',
    title: 'Северо-Западный технологический университет — практикум по анализу данных', organizationId: organizations[0].id,
    personId: people[0].id, stageKey: 'meeting', routeVersion: 'legacy', owner: users[0], priority: 2,
    createdAt: '2026-09-08T09:00:00.000Z', updatedAt: '2026-09-17T13:00:00.000Z',
  },
  {
    id: 'a3000000-0000-4000-8000-000000000002', kind: 'corporate',
    title: 'Геоаналитика — обучение аналитиков работе с корпоративными данными', organizationId: organizations[1].id,
    personId: people[1].id, stageKey: 'brief', routeVersion: 'legacy', owner: users[0], priority: 1,
    createdAt: '2026-09-10T10:00:00.000Z', updatedAt: '2026-09-18T12:00:00.000Z',
  },
  {
    id: 'a3000000-0000-4000-8000-000000000003', kind: 'individual',
    title: 'Мира Левина — консультация по программе аналитики данных', organizationId: null,
    personId: people[2].id, stageKey: 'consultation', routeVersion: 'v2', owner: users[0], priority: 3,
    createdAt: '2026-09-12T11:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z',
  },
  { id: 'a3000000-0000-4000-8000-000000000004', kind: 'university', title: 'Северо-Западный технологический университет — повышение квалификации преподавателей', organizationId: organizations[0].id, personId: people[0].id, stageKey: 'contact', routeVersion: 'legacy', owner: users[0], priority: 4, initialStage: 'contact', createdAt: '2026-09-15T08:00:00.000Z', updatedAt: '2026-09-22T10:00:00.000Z' },
  { id: 'a3000000-0000-4000-8000-000000000005', kind: 'university', title: 'Колледж «Вектор» — программа по веб-разработке для студентов', organizationId: organizations[2].id, personId: people[3].id, stageKey: 'meeting', routeVersion: 'legacy', owner: users[1], priority: 2, initialStage: 'contact', stageHistory: [{ from: 'contact', to: 'meeting', at: '2026-09-20T10:00:00.000Z' }], createdAt: '2026-09-11T09:00:00.000Z', updatedAt: '2026-09-23T09:00:00.000Z' },
  { id: 'a3000000-0000-4000-8000-000000000006', kind: 'university', title: 'Колледж «Вектор» — согласование учебных материалов и лицензий', organizationId: organizations[2].id, personId: people[3].id, stageKey: 'documents', routeVersion: 'legacy', owner: users[1], priority: 1, initialStage: 'meeting', stageHistory: [{ from: 'meeting', to: 'documents', at: '2026-09-21T09:00:00.000Z' }], createdAt: '2026-09-14T10:00:00.000Z', updatedAt: '2026-09-23T13:00:00.000Z' },
  { id: 'a3000000-0000-4000-8000-000000000007', kind: 'corporate', title: 'Геоаналитика — вводный практикум по визуализации данных', organizationId: organizations[1].id, personId: people[1].id, stageKey: 'approval', routeVersion: 'legacy', owner: users[0], priority: 2, initialStage: 'qualification', stageHistory: [{ from: 'qualification', to: 'brief', at: '2026-09-18T09:00:00.000Z' }, { from: 'brief', to: 'approval', at: '2026-09-22T09:00:00.000Z' }], createdAt: '2026-09-13T09:00:00.000Z', updatedAt: '2026-09-24T10:00:00.000Z' },
  { id: 'a3000000-0000-4000-8000-000000000008', kind: 'corporate', title: 'ПромСфера — обучение инженеров цифровым инструментам', organizationId: organizations[3].id, personId: people[4].id, stageKey: 'qualification', routeVersion: 'legacy', owner: users[1], priority: 5, initialStage: 'qualification', createdAt: '2026-09-16T10:00:00.000Z', updatedAt: '2026-09-20T15:00:00.000Z' },
  { id: 'a3000000-0000-4000-8000-000000000009', kind: 'corporate', title: 'ПромСфера — бриф для программы управления ИТ-проектами', organizationId: organizations[3].id, personId: people[4].id, stageKey: 'brief', routeVersion: 'legacy', owner: users[1], priority: 3, initialStage: 'qualification', stageHistory: [{ from: 'qualification', to: 'brief', at: '2026-09-22T10:00:00.000Z' }], createdAt: '2026-09-17T10:00:00.000Z', updatedAt: '2026-09-25T13:00:00.000Z' },
  { id: 'a3000000-0000-4000-8000-000000000010', kind: 'individual', title: 'Олеся Ветрова — выбор формата обучения веб-разработке', organizationId: null, personId: people[5].id, stageKey: 'request', routeVersion: 'v2', owner: users[0], priority: 1, initialStage: 'request', createdAt: '2026-09-20T08:00:00.000Z', updatedAt: '2026-09-24T09:00:00.000Z' },
  { id: 'a3000000-0000-4000-8000-000000000011', kind: 'individual', title: 'Тимур Егоров — подбор программы управления ИТ-проектами', organizationId: null, personId: people[6].id, stageKey: 'conditions', routeVersion: 'v2', owner: users[1], priority: 2, initialStage: 'request', stageHistory: [{ from: 'request', to: 'consultation', at: '2026-09-23T09:00:00.000Z' }, { from: 'consultation', to: 'conditions', at: '2026-09-25T09:00:00.000Z' }], createdAt: '2026-09-21T08:30:00.000Z', updatedAt: '2026-09-26T14:00:00.000Z' },
];

const tasks = [
  // Preserve the original task IDs and values as well.
  { id: 'a4000000-0000-4000-8000-000000000001', activityId: activities[0].id, title: 'Подготовить вопросы к встрече', dueAt: '2026-10-05T09:00:00.000Z', status: 'open', owner: users[0], createdAt: '2026-09-17T13:00:00.000Z', completedAt: null },
  { id: 'a4000000-0000-4000-8000-000000000002', activityId: activities[1].id, title: 'Сверить состав брифа', dueAt: '2026-10-06T09:00:00.000Z', status: 'open', owner: users[0], createdAt: '2026-09-18T12:00:00.000Z', completedAt: null },
  { id: 'a4000000-0000-4000-8000-000000000003', activityId: activities[2].id, title: 'Согласовать время консультации', dueAt: '2026-09-20T09:00:00.000Z', status: 'done', owner: users[0], createdAt: '2026-09-19T10:00:00.000Z', completedAt: '2026-09-19T14:00:00.000Z' },
  { id: 'a4000000-0000-4000-8000-000000000004', activityId: activities[3].id, title: 'Уточнить целевую аудиторию преподавателей', dueAt: '2026-10-02T09:00:00.000Z', status: 'open', owner: users[0], createdAt: '2026-09-21T10:00:00.000Z', completedAt: null },
  { id: 'a4000000-0000-4000-8000-000000000005', activityId: activities[4].id, title: 'Зафиксировать итоги встречи', dueAt: '2026-09-26T09:00:00.000Z', status: 'done', owner: users[1], createdAt: '2026-09-22T11:00:00.000Z', completedAt: '2026-09-23T09:00:00.000Z' },
  { id: 'a4000000-0000-4000-8000-000000000006', activityId: activities[5].id, title: 'Собрать перечень материалов для проверки', dueAt: '2026-10-04T09:00:00.000Z', status: 'open', owner: users[1], createdAt: '2026-09-23T13:00:00.000Z', completedAt: null },
  { id: 'a4000000-0000-4000-8000-000000000007', activityId: activities[6].id, title: 'Согласовать состав вводного практикума', dueAt: '2026-10-07T09:00:00.000Z', status: 'open', owner: users[0], createdAt: '2026-09-24T10:00:00.000Z', completedAt: null },
  { id: 'a4000000-0000-4000-8000-000000000008', activityId: activities[7].id, title: 'Подготовить вопросы для первого звонка', dueAt: '2026-09-30T09:00:00.000Z', status: 'open', owner: users[1], createdAt: '2026-09-20T15:00:00.000Z', completedAt: null },
  { id: 'a4000000-0000-4000-8000-000000000009', activityId: activities[8].id, title: 'Заполнить недостающие пункты брифа', dueAt: '2026-10-08T09:00:00.000Z', status: 'open', owner: users[1], createdAt: '2026-09-25T12:00:00.000Z', completedAt: null },
  { id: 'a4000000-0000-4000-8000-000000000010', activityId: activities[9].id, title: 'Подготовить ответ по форматам консультации', dueAt: '2026-10-01T09:00:00.000Z', status: 'open', owner: users[0], createdAt: '2026-09-24T09:00:00.000Z', completedAt: null },
  { id: 'a4000000-0000-4000-8000-000000000011', activityId: activities[10].id, title: 'Уточнить предпочтительное расписание', dueAt: '2026-10-05T09:00:00.000Z', status: 'open', owner: users[1], createdAt: '2026-09-26T14:00:00.000Z', completedAt: null },
  { id: 'a4000000-0000-4000-8000-000000000012', activityId: activities[3].id, title: 'Подготовить два варианта повестки', dueAt: '2026-10-06T09:00:00.000Z', status: 'open', owner: users[0], createdAt: '2026-09-22T10:00:00.000Z', completedAt: null },
  { id: 'a4000000-0000-4000-8000-000000000013', activityId: activities[6].id, title: 'Свести открытые вопросы для руководителя', dueAt: '2026-09-26T09:00:00.000Z', status: 'done', owner: users[0], createdAt: '2026-09-23T10:00:00.000Z', completedAt: '2026-09-24T09:00:00.000Z' },
  { id: 'a4000000-0000-4000-8000-000000000014', activityId: activities[8].id, title: 'Проверить внутренний черновик брифа', dueAt: '2026-10-03T09:00:00.000Z', status: 'open', owner: users[1], createdAt: '2026-09-25T13:00:00.000Z', completedAt: null },
];

const legacyEvents = [
  { id: 'a5000000-0000-4000-8000-000000000001', activity: activities[0], type: 'created', summary: 'Создана активность', details: { kind: 'university', origin: 'manual', routeVersion: 'legacy', initialStage: 'contact', productIds: [], programIds: [] }, actor: users[0], at: '2026-09-08T09:00:00.000Z' },
  { id: 'a5000000-0000-4000-8000-000000000002', activity: activities[0], type: 'stage_changed', summary: 'Стадия изменена: Встреча и потребность', details: { from: 'contact', to: 'meeting' }, actor: users[0], at: '2026-09-17T12:00:00.000Z' },
  { id: 'a5000000-0000-4000-8000-000000000003', activity: activities[0], type: 'task_created', summary: 'Поставлено действие: Подготовить вопросы к встрече', details: { taskId: tasks[0].id, dueAt: tasks[0].dueAt }, actor: users[0], at: '2026-09-17T13:00:00.000Z' },
  { id: 'a5000000-0000-4000-8000-000000000004', activity: activities[1], type: 'created', summary: 'Создана активность', details: { kind: 'corporate', origin: 'manual', routeVersion: 'legacy', initialStage: 'qualification', productIds: [], programIds: [] }, actor: users[0], at: '2026-09-10T10:00:00.000Z' },
  { id: 'a5000000-0000-4000-8000-000000000005', activity: activities[1], type: 'stage_changed', summary: 'Руководитель перевёл активность на этап брифа', details: { from: 'qualification', to: 'brief' }, actor: users[1], at: '2026-09-18T11:00:00.000Z' },
  { id: 'a5000000-0000-4000-8000-000000000006', activity: activities[1], type: 'task_created', summary: 'Поставлено действие: Сверить состав брифа', details: { taskId: tasks[1].id, dueAt: tasks[1].dueAt }, actor: users[0], at: '2026-09-18T12:00:00.000Z' },
  { id: 'a5000000-0000-4000-8000-000000000007', activity: activities[2], type: 'created', summary: 'Создана активность', details: { kind: 'individual', origin: 'manual', routeVersion: 'v2', initialStage: 'request', productIds: [], programIds: [] }, actor: users[0], at: '2026-09-12T11:00:00.000Z' },
  { id: 'a5000000-0000-4000-8000-000000000008', activity: activities[2], type: 'stage_changed', summary: 'Запрос перешёл к консультации', details: { from: 'request', to: 'consultation' }, actor: users[0], at: '2026-09-19T09:00:00.000Z' },
  { id: 'a5000000-0000-4000-8000-000000000009', activity: activities[2], type: 'task_created', summary: 'Поставлено действие: Согласовать время консультации', details: { taskId: tasks[2].id, dueAt: tasks[2].dueAt }, actor: users[0], at: '2026-09-19T10:00:00.000Z' },
  { id: 'a5000000-0000-4000-8000-000000000010', activity: activities[2], type: 'task_completed', summary: 'Выполнено действие: Согласовать время консультации', details: { taskId: tasks[2].id }, actor: users[0], at: '2026-09-19T14:00:00.000Z' },
];

const productIds = {
  dataLake: '44444444-4444-4444-8444-444444444401',
  basis: '44444444-4444-4444-8444-444444444404',
  aurora: '44444444-4444-4444-8444-444444444405',
  web3Gate: '44444444-4444-4444-8444-444444444406',
  akola: '44444444-4444-4444-8444-444444444407',
};
const programIds = {
  akolaWeb: '55555555-5555-4555-8555-555555555501',
  basisDevOps: '55555555-5555-4555-8555-555555555502',
  auroraMobile: '55555555-5555-4555-8555-555555555503',
  web3: '55555555-5555-4555-8555-555555555504',
  dataAnalysis: '55555555-5555-4555-8555-555555555505',
  projectManagement: '55555555-5555-4555-8555-555555555506',
};
const activityProducts = [
  [activities[3].id, productIds.basis], [activities[4].id, productIds.akola],
  [activities[5].id, productIds.aurora], [activities[6].id, productIds.dataLake],
  [activities[7].id, productIds.web3Gate], [activities[8].id, productIds.dataLake],
];
const activityPrograms = [
  [activities[3].id, programIds.basisDevOps], [activities[4].id, programIds.akolaWeb],
  [activities[5].id, programIds.auroraMobile], [activities[6].id, programIds.dataAnalysis],
  [activities[7].id, programIds.web3], [activities[8].id, programIds.projectManagement],
  [activities[9].id, programIds.akolaWeb], [activities[10].id, programIds.projectManagement],
];

const planBriefs = [
  { expectedOutcome: 'Составить черновик практикума по аналитике данных.', audience: 'Проектная группа компании.', entryLevel: 'Начальный уровень обсуждается.', deliveryFormat: 'Смешанный формат рассматривается.', volume: 'Несколько вводных занятий.', technologyContext: 'Пример связан с учебным каталогом аналитики.' },
  { expectedOutcome: 'Подготовить отдельный вводный практикум.', audience: 'Небольшая группа координаторов.', entryLevel: 'Без предварительных требований в сценарии.', deliveryFormat: 'Формат ещё не выбран.', volume: 'Короткий обзорный блок.', technologyContext: 'Направление связано с каталогом Базис.' },
  { expectedOutcome: 'Обсудить цифровые процессы команды.', audience: 'Сотрудники компании.', entryLevel: 'Уровень будет уточнён.', deliveryFormat: 'Рассматривается дистанционный формат.', volume: 'Объём пока не оценён.', technologyContext: 'Рассматривается программа по RT.Web3Gate.' },
  { expectedOutcome: 'Подготовить новую программу для проектной команды.', audience: 'Сотрудники проектной группы.', entryLevel: 'Состав группы уточняется.', deliveryFormat: 'Формат обсуждается.', volume: 'Черновая оценка объёма.', technologyContext: 'Направление выбрано после первичного брифа.' },
];
const corporatePlans = activities.filter((activity) => activity.kind === 'corporate').map((activity, index) => ({
  activity, programMode: ['undecided', 'adapted', 'standard', 'new'][index], requestedPlaces: [18, 24, 12, 30][index],
  brief: planBriefs[index],
  methodologist: { name: null, feasibility: 'unassessed', note: 'Методическая оценка ещё не проводилась.' },
  proposed: { scope: null, startDate: null, endDate: null, acceptanceCriteria: null },
  agreed: { scope: null, startDate: null, endDate: null, acceptanceCriteria: null },
  approval: { status: 'not_recorded', evidenceReference: null, evidenceSource: null, note: 'Решение не зафиксировано.' },
  revision: 1, updatedAt: activity.updatedAt, actor: activity.owner,
}));

const universitySteps = [
  { activity: activities[0], stepId: 'U01', status: 'in_progress', note: 'Уточняется контакт ответственного.', updatedAt: '2026-09-17T11:00:00.000Z' },
  { activity: activities[0], stepId: 'U03', status: 'waiting', note: 'Встреча ожидает подтверждения времени.', updatedAt: '2026-09-17T11:05:00.000Z' },
  { activity: activities[3], stepId: 'U01', status: 'in_progress', note: 'Запрос принят к проработке.', updatedAt: '2026-09-21T09:00:00.000Z' },
  { activity: activities[3], stepId: 'U02', status: 'waiting', note: 'Темы программы ещё уточняются.', updatedAt: '2026-09-21T09:05:00.000Z' },
  { activity: activities[4], stepId: 'U03', status: 'in_progress', note: 'Ведётся подготовка к встрече.', updatedAt: '2026-09-22T10:00:00.000Z' },
  { activity: activities[5], stepId: 'U04', status: 'waiting', note: 'Перечень документов уточняется.', updatedAt: '2026-09-23T12:00:00.000Z' },
  { activity: activities[5], stepId: 'U06', status: 'not_applicable', note: 'Подписание пока не рассматривается.', updatedAt: '2026-09-23T12:05:00.000Z' },
];

const universityContractLicenses = [
  {
    id: 'a6000000-0000-4000-8000-000000000001', activity: activities[0],
    title: 'Соглашение о сотрудничестве по цифровым навыкам', contractReference: null,
    contractStatus: 'unknown', licenseExpiryPrecision: null, licenseExpiresOn: null, licenseExpiresYear: null,
    documentId: null, note: 'Сведения о подписании и сроке действия не подтверждены; документ не приложен.',
    revision: 1, updatedAt: '2026-09-17T14:00:00.000Z',
  },
  {
    id: 'a6000000-0000-4000-8000-000000000002', activity: activities[0],
    title: 'Лицензия на учебные материалы по цифровым навыкам', contractReference: null,
    contractStatus: 'unknown', licenseExpiryPrecision: 'year', licenseExpiresOn: null, licenseExpiresYear: 2027,
    documentId: null, note: 'Срок указан только с точностью до года; конкретная дата не задана, документ не приложен.',
    revision: 1, updatedAt: '2026-09-17T14:05:00.000Z',
  },
  {
    id: 'a6000000-0000-4000-8000-000000000003', activity: activities[3],
    title: 'Дополнение к программе для преподавателей', contractReference: null,
    contractStatus: 'draft', licenseExpiryPrecision: null, licenseExpiresOn: null, licenseExpiresYear: null,
    documentId: null, note: 'Подписание не зафиксировано; документ не приложен.',
    revision: 1, updatedAt: '2026-09-22T10:30:00.000Z',
  },
  {
    id: 'a6000000-0000-4000-8000-000000000004', activity: activities[4],
    title: 'Соглашение о проведении встречи по учебным материалам', contractReference: null,
    contractStatus: 'unknown', licenseExpiryPrecision: null, licenseExpiresOn: null, licenseExpiresYear: null,
    documentId: null, note: 'Сведения о подписании и сроке действия не подтверждены; документ не приложен.',
    revision: 1, updatedAt: '2026-09-23T09:05:00.000Z',
  },
  {
    id: 'a6000000-0000-4000-8000-000000000005', activity: activities[5],
    title: 'Лицензия на учебные материалы по прикладной механике', contractReference: null,
    contractStatus: 'unknown', licenseExpiryPrecision: 'year', licenseExpiresOn: null, licenseExpiresYear: 2028,
    documentId: null, note: 'Срок указан только с точностью до года; конкретная дата не задана, документ не приложен.',
    revision: 1, updatedAt: '2026-09-23T12:10:00.000Z',
  },
  {
    id: 'a6000000-0000-4000-8000-000000000006', activity: activities[5],
    title: 'Проект условий доступа к учебным материалам', contractReference: null,
    contractStatus: 'draft', licenseExpiryPrecision: null, licenseExpiresOn: null, licenseExpiresYear: null,
    documentId: null, note: 'Подписание не зафиксировано; документ не приложен.',
    revision: 1, updatedAt: '2026-09-23T12:15:00.000Z',
  },
];

let nextEventNumber = 11;
function makeEvent({ activity, type, summary, details, actor, at }) {
  return { id: `a5000000-0000-4000-8000-${String(nextEventNumber++).padStart(12, '0')}`, activity, type, summary, details, actor, at };
}
const newActivityEvents = [];
const stageLabels = {
  contact: 'Первичный контакт', meeting: 'Встреча и потребность', documents: 'Документы и согласование',
  qualification: 'Потребность компании', brief: 'Бриф и оценка', approval: 'Согласование программы',
  request: 'Новая заявка', consultation: 'Консультация', conditions: 'Условия обучения',
};
for (const activity of activities.slice(3)) {
  newActivityEvents.push(makeEvent({
    activity, type: 'created', summary: 'Создана активность',
    details: { kind: activity.kind, origin: 'manual', routeVersion: activity.routeVersion, initialStage: activity.initialStage, productIds: activityProducts.filter(([id]) => id === activity.id).map(([, id]) => id), programIds: activityPrograms.filter(([id]) => id === activity.id).map(([, id]) => id) },
    actor: activity.owner, at: activity.createdAt,
  }));
  for (const transition of activity.stageHistory ?? []) {
    newActivityEvents.push(makeEvent({ activity, type: 'stage_changed', summary: `Стадия изменена: ${stageLabels[transition.to]}`, details: { from: transition.from, to: transition.to }, actor: activity.owner, at: transition.at }));
  }
  if (activity.kind === 'individual') {
    newActivityEvents.push(makeEvent({ activity, type: 'outcome_recorded', summary: 'Итог контакта: ожидается ответ', details: { outcome: 'awaiting_reply', note: 'Ответ ожидается после консультации.' }, actor: activity.owner, at: activity.updatedAt }));
  }
  for (const task of tasks.filter((candidate) => candidate.activityId === activity.id)) {
    newActivityEvents.push(makeEvent({ activity, type: 'task_created', summary: `Поставлено действие: ${task.title}`, details: { taskId: task.id, dueAt: task.dueAt }, actor: task.owner, at: task.createdAt }));
    if (task.status === 'done') newActivityEvents.push(makeEvent({ activity, type: 'task_completed', summary: `Выполнено действие: ${task.title}`, details: { taskId: task.id }, actor: task.owner, at: task.completedAt }));
  }
}
const domainEvents = [
  ...corporatePlans.map((plan) => makeEvent({ activity: plan.activity, type: 'corporate_plan_updated', summary: 'Обновлён черновой план корпоративной программы', details: { revision: plan.revision, syntheticDemo: true }, actor: plan.actor, at: plan.updatedAt })),
  ...universitySteps.map((step) => makeEvent({ activity: step.activity, type: 'university_step_updated', summary: `Обновлён ход по шагу ${step.stepId}`, details: { stepId: step.stepId, status: step.status, revision: 1, syntheticDemo: true }, actor: step.activity.owner, at: step.updatedAt })),
];
const events = [...legacyEvents, ...newActivityEvents, ...domainEvents];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export const syntheticDemoSeed = deepFreeze({ users, organizations, people, activities, tasks, events, activityProducts, activityPrograms, corporatePlans, universitySteps, universityContractLicenses, productIds, programIds });
export function buildSyntheticDemoSeed() { return structuredClone(syntheticDemoSeed); }

export function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) return { dryRun: true };
  if (args.length === 1 && args[0] === '--apply-local-demo') return { apply: true };
  throw new Error('Use --dry-run (default), --apply-local-demo, or --help. Database overrides are not supported.');
}

export function assertTargetDatabase({ host, port, database, marker }) {
  if (host !== LOCAL_HOST || Number(port) !== LOCAL_PORT || database !== DEMO_DATABASE) {
    throw new Error('Synthetic demo seeding is restricted to 127.0.0.1:54329/lctcrm_demo.');
  }
  if (marker !== DEMO_MARKER) throw new Error(`Database ${DEMO_DATABASE} is not marked as an isolated synthetic demo database.`);
}

function help() {
  console.log(`Seed the isolated local synthetic_demo database. No changes happen by default.

Preview the deterministic fixture:
  node scripts/seed-synthetic-demo.mjs --dry-run

Create lctcrm_demo from empty template0, apply repository migrations, and seed it:
  node scripts/seed-synthetic-demo.mjs --apply-local-demo

The script always connects to 127.0.0.1:54329 and targets only lctcrm_demo.
It resolves the four existing QA usernames through local Keycloak using credentials
from .env.local. It never clones lctcrm, accepts DATABASE_URL overrides, changes
Keycloak accounts, or adds LMS facts. Existing unmarked databases are left unchanged.
`);
}

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

async function localConfig() {
  let values;
  try { values = parseEnv(await readFile(path.join(ROOT, '.env.local'), 'utf8')); }
  catch { throw new Error('Local .env.local is required. Start the local stand first to create its PostgreSQL secret.'); }
  if (!values.POSTGRES_PASSWORD) throw new Error('POSTGRES_PASSWORD is missing from local .env.local.');
  if (!values.KC_ADMIN_USER || !values.KC_ADMIN_PASSWORD) throw new Error('Local Keycloak administrator credentials are missing from .env.local.');
  const password = encodeURIComponent(values.POSTGRES_PASSWORD);
  return {
    bootstrapUrl: `postgres://${DB_USER}:${password}@${LOCAL_HOST}:${LOCAL_PORT}/postgres?application_name=crm-synthetic-demo-seed`,
    databaseUrl: `postgres://${DB_USER}:${password}@${LOCAL_HOST}:${LOCAL_PORT}/${DEMO_DATABASE}?application_name=crm-synthetic-demo-seed`,
    keycloakUrl: values.KEYCLOAK_URL || 'http://localhost:18080',
    keycloakAdminUser: values.KC_ADMIN_USER,
    keycloakAdminPassword: values.KC_ADMIN_PASSWORD,
  };
}

export function assertLocalKeycloakUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Local Keycloak URL must point to a loopback address.'); }
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (!['http:', 'https:'].includes(url.protocol) || !loopbackHosts.has(url.hostname.toLowerCase())
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Local Keycloak URL must point to a loopback address.');
  }
  return url.toString().replace(/\/$/, '');
}

export function buildKeycloakSubjectMap(seedUsers, keycloakUsers) {
  const subjects = new Map();
  const usedSubjects = new Set();
  for (const user of seedUsers) {
    const matches = keycloakUsers.filter((candidate) => candidate?.username === user.username);
    if (matches.length !== 1 || typeof matches[0]?.id !== 'string' || !matches[0].id.trim()) {
      throw new Error(`Local Keycloak must contain exactly one account for ${user.username}.`);
    }
    if (usedSubjects.has(matches[0].id)) throw new Error('Local Keycloak returned duplicate subjects for the QA accounts.');
    subjects.set(user.username, matches[0].id);
    usedSubjects.add(matches[0].id);
  }
  for (const user of seedUsers) {
    const currentOwner = seedUsers.find((candidate) => candidate.sub === subjects.get(user.username));
    if (currentOwner && currentOwner.username !== user.username) {
      throw new Error('A local Keycloak subject collides with another fixture identity; seed migration was stopped.');
    }
  }
  return subjects;
}

export async function resolveLocalKeycloakSubjects({ baseUrl, adminUser, adminPassword, seedUsers = users, fetchImpl = fetch }) {
  const base = assertLocalKeycloakUrl(baseUrl);
  if (!adminUser || !adminPassword) throw new Error('Local Keycloak administrator credentials are missing.');
  const tokenResponse = await fetchImpl(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: adminUser, password: adminPassword }),
  });
  if (!tokenResponse.ok) throw new Error('Could not authenticate to local Keycloak.');
  const tokenPayload = await tokenResponse.json();
  if (typeof tokenPayload?.access_token !== 'string' || !tokenPayload.access_token) throw new Error('Local Keycloak returned no access token.');
  const keycloakUsers = [];
  for (const user of seedUsers) {
    const endpoint = `${base}/admin/realms/lct/users?username=${encodeURIComponent(user.username)}&exact=true`;
    const response = await fetchImpl(endpoint, {
      redirect: 'error', headers: { authorization: `Bearer ${tokenPayload.access_token}`, accept: 'application/json' },
    });
    if (!response.ok) throw new Error('Could not read QA accounts from local Keycloak.');
    const matches = await response.json();
    if (!Array.isArray(matches)) throw new Error('Local Keycloak returned an invalid QA account list.');
    keycloakUsers.push(...matches);
  }
  return buildKeycloakSubjectMap(seedUsers, keycloakUsers);
}

async function runMigrations(databaseUrl) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'api/src/db/migrate.ts'], {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit',
    });
    child.once('error', () => reject(new Error('Could not start the CRM migration runner.')));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`CRM migration runner exited with code ${code ?? 'signal'}.`)));
  });
}

async function ensureDemoDatabase(bootstrapUrl) {
  const client = new pg.Client({ connectionString: bootstrapUrl });
  await client.connect();
  try {
    const connection = await client.query('SELECT current_database() AS database');
    if (connection.rows[0]?.database !== 'postgres') throw new Error('Bootstrap connection did not reach local postgres database.');
    const found = await client.query('SELECT datistemplate, shobj_description(oid, \'pg_database\') AS marker FROM pg_database WHERE datname=$1', [DEMO_DATABASE]);
    if (!found.rowCount) {
      await client.query(`CREATE DATABASE ${DEMO_DATABASE} TEMPLATE template0`);
      await client.query(`COMMENT ON DATABASE ${DEMO_DATABASE} IS '${DEMO_MARKER}'`);
      return { created: true };
    }
    const row = found.rows[0];
    assertTargetDatabase({ host: LOCAL_HOST, port: LOCAL_PORT, database: DEMO_DATABASE, marker: row.marker });
    if (row.datistemplate) throw new Error('The target database is a PostgreSQL template; it was left unchanged.');
    return { created: false };
  } finally {
    await client.end();
  }
}

function insertedCount(result) { return result.rowCount ?? 0; }

function priorVisibleLabel(value) { return `DEMO · ${value}`; }

export async function upgradePriorVisibleLabels(client) {
  // Upgrade only literal values written by the earlier seed. Any edited row is left alone.
  for (const org of organizations) {
    const previousName = priorVisibleLabel(org.name);
    await client.query('UPDATE organizations SET name=$2 WHERE id=$1 AND name=$3', [org.id, org.name, previousName]);
    for (const person of people.filter((candidate) => candidate.organizationName === org.name)) {
      await client.query('UPDATE people SET organization_name=$2 WHERE id=$1 AND organization_name=$3', [person.id, org.name, previousName]);
    }
  }
  for (const activity of activities) {
    await client.query('UPDATE activities SET title=$2 WHERE id=$1 AND title=$3', [activity.id, activity.title, priorVisibleLabel(activity.title)]);
  }
  for (const event of events) {
    const previousSummary = event.summary === 'Создана активность'
      ? 'Создана DEMO-активность'
      : priorVisibleLabel(event.summary);
    await client.query('UPDATE activity_events SET summary=$2 WHERE id=$1 AND summary=$3', [event.id, event.summary, previousSummary]);
    const currentNote = event.details?.note;
    if (currentNote) {
      await client.query(`UPDATE activity_events SET details=jsonb_set(details,'{note}',to_jsonb($3::text),false)
        WHERE id=$1 AND details->>'note'=$2`, [event.id, priorVisibleLabel(currentNote), currentNote]);
    }
  }
  for (const plan of corporatePlans) {
    const priorBrief = Object.fromEntries(Object.entries(plan.brief).map(([key, value]) => [key, priorVisibleLabel(value)]));
    await client.query(`UPDATE corporate_activity_plans SET brief=$2::jsonb
      WHERE activity_id=$1 AND brief=$3::jsonb`, [plan.activity.id, JSON.stringify(plan.brief), JSON.stringify(priorBrief)]);
    for (const [column, value] of [['methodologist', plan.methodologist], ['approval', plan.approval]]) {
      const priorValue = { ...value, note: priorVisibleLabel(value.note) };
      await client.query(`UPDATE corporate_activity_plans SET ${column}=$2::jsonb
        WHERE activity_id=$1 AND ${column}=$3::jsonb`, [plan.activity.id, JSON.stringify(value), JSON.stringify(priorValue)]);
    }
  }
  for (const step of universitySteps) {
    await client.query(`UPDATE activity_university_steps SET note=$3
      WHERE activity_id=$1 AND step_id=$2 AND note=$4`, [step.activity.id, step.stepId, step.note, priorVisibleLabel(step.note)]);
  }
}

export async function migrateSeedSubjectReferences(client, resolvedUsers = users) {
  const resolvedByUsername = new Map(resolvedUsers.map((user) => [user.username, user]));
  const mappings = [
    ...users.map((user) => ({ sub: user.sub, username: user.username })),
    ...priorSeedUsers,
  ];
  const activityIds = activities.map((activity) => activity.id);
  const taskIds = tasks.map((task) => task.id);
  const eventIds = events.map((event) => event.id);
  const planActivityIds = corporatePlans.map((plan) => plan.activity.id);
  const contractLicenseIds = universityContractLicenses.map((record) => record.id);

  for (const prior of mappings) {
    const replacement = resolvedByUsername.get(prior.username);
    if (!replacement) throw new Error(`No resolved local Keycloak identity for ${prior.username}.`);
    if (prior.sub === replacement.sub) continue;
    const original = users.find((user) => user.username === prior.username);
    const oldName = original.name;
    const nextName = replacement.name;

    // Restrict every rewrite to an exact seed primary key and unchanged seed identity fields.
    await client.query(`UPDATE activities SET owner_sub=$2,owner_name=$5
      WHERE id=ANY($1::uuid[]) AND owner_sub=$3 AND owner_name=$4`, [
      activityIds.filter((id) => activities.find((activity) => activity.id === id)?.owner.username === prior.username),
      replacement.sub, prior.sub, oldName, nextName,
    ]);
    await client.query(`UPDATE tasks SET owner_sub=$2,owner_name=$5
      WHERE id=ANY($1::uuid[]) AND owner_sub=$3 AND owner_name=$4`, [
      taskIds.filter((id) => tasks.find((task) => task.id === id)?.owner.username === prior.username),
      replacement.sub, prior.sub, oldName, nextName,
    ]);
    await client.query(`UPDATE activity_events SET actor_sub=$2,actor_name=$5
      WHERE id=ANY($1::uuid[]) AND actor_sub=$3 AND actor_name=$4`, [
      eventIds.filter((id) => events.find((event) => event.id === id)?.actor.username === prior.username),
      replacement.sub, prior.sub, oldName, nextName,
    ]);
    await client.query(`UPDATE activity_contract_licenses SET actor_sub=$2,actor_name=$5
      WHERE id=ANY($1::uuid[]) AND actor_sub=$3 AND actor_name=$4`, [
      contractLicenseIds.filter((id) => universityContractLicenses.find((record) => record.id === id)?.activity.owner.username === prior.username),
      replacement.sub, prior.sub, oldName, nextName,
    ]);
    await client.query(`UPDATE corporate_activity_plans SET actor_sub=$2,actor_name=$5
      WHERE activity_id=ANY($1::uuid[]) AND actor_sub=$3 AND actor_name=$4`, [
      planActivityIds.filter((id) => corporatePlans.find((plan) => plan.activity.id === id)?.actor.username === prior.username),
      replacement.sub, prior.sub, oldName, nextName,
    ]);
    for (const step of universitySteps.filter((candidate) => candidate.activity.owner.username === prior.username)) {
      await client.query(`UPDATE activity_university_steps SET actor_sub=$3,actor_name=$5
        WHERE activity_id=$1 AND step_id=$2 AND actor_sub=$4 AND actor_name=$6`, [
        step.activity.id, step.stepId, replacement.sub, prior.sub, nextName, oldName,
      ]);
    }
    if (original.roles.includes('kam')) await client.query('DELETE FROM kam_directory WHERE user_sub=$1 AND provision_source=$2', [prior.sub, SEED_SOURCE]);
    await client.query('DELETE FROM known_crm_users WHERE user_sub=$1 AND provision_source=$2', [prior.sub, SEED_SOURCE]);
  }
}

export async function seedUniversityContractLicenses(client, subFor = (user) => user.sub) {
  let inserted = 0;
  for (const record of universityContractLicenses) {
    inserted += insertedCount(await client.query(`INSERT INTO activity_contract_licenses(
      id,activity_id,title,contract_reference,contract_status,license_expiry_precision,license_expires_on,license_expires_year,
      document_id,note,revision,updated_at,actor_sub,actor_name
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO NOTHING`, [
      record.id, record.activity.id, record.title, record.contractReference, record.contractStatus,
      record.licenseExpiryPrecision, record.licenseExpiresOn, record.licenseExpiresYear,
      record.documentId, record.note, record.revision, record.updatedAt,
      subFor(record.activity.owner), record.activity.owner.name,
    ]));
  }
  return inserted;
}

function isoTimestamp(value) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function isoDate(value) { return value instanceof Date ? value.toISOString().slice(0, 10) : value?.slice(0, 10) ?? null; }

export async function verifyUniversityContractLicenses(client, resolvedUsers = users) {
  const subFor = (user) => resolvedUsers.find((candidate) => candidate.username === user.username)?.sub ?? user.sub;
  const result = await client.query(`SELECT id,activity_id,title,contract_reference,contract_status,license_expiry_precision,
      license_expires_on,license_expires_year,document_id,note,revision,updated_at,actor_sub,actor_name
    FROM activity_contract_licenses WHERE id=ANY($1::uuid[])`, [universityContractLicenses.map((record) => record.id)]);
  const matches = result.rows.length === universityContractLicenses.length && universityContractLicenses.every((expected) => {
    const row = result.rows.find((candidate) => candidate.id === expected.id);
    return row
      && row.activity_id === expected.activity.id
      && row.title === expected.title
      && row.contract_reference === expected.contractReference
      && row.contract_status === expected.contractStatus
      && row.license_expiry_precision === expected.licenseExpiryPrecision
      && isoDate(row.license_expires_on) === expected.licenseExpiresOn
      && row.license_expires_year === expected.licenseExpiresYear
      && row.document_id === expected.documentId
      && row.note === expected.note
      && Number(row.revision) === expected.revision
      && isoTimestamp(row.updated_at) === expected.updatedAt
      && row.actor_sub === subFor(expected.activity.owner)
      && row.actor_name === expected.activity.owner.name;
  });
  if (!matches) throw new Error('Seed verification found a conflicting university contract/license context; existing rows were preserved.');
}

async function seed(client, resolvedSubjects, options = {}) {
  const targetGuard = options.targetGuard ?? ((identity) => assertTargetDatabase({
    host: LOCAL_HOST, port: LOCAL_PORT, database: identity.database, marker: identity.marker,
  }));
  const seedSource = options.seedSource ?? SEED_SOURCE;
  const seedTasks = options.tasks ?? tasks;
  const seedEvents = options.events ?? events;
  const resolvedUsers = users.map((user) => ({ ...user, sub: resolvedSubjects.get(user.username) ?? user.sub }));
  const subFor = (user) => resolvedSubjects.get(user.username) ?? user.sub;
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('synthetic-demo-seed-v1'))");
    const identity = await client.query(`SELECT current_database() AS database,
      shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()), 'pg_database') AS marker`);
    targetGuard(identity.rows[0] ?? {});

    const inserted = { users: 0, organizations: 0, people: 0, kamDirectory: 0, activities: 0, tasks: 0, history: 0, productLinks: 0, programLinks: 0, corporatePlans: 0, universitySteps: 0, universityContractLicenses: 0 };
    if (options.upgradeLegacyRows !== false) await upgradePriorVisibleLabels(client);
    for (const org of organizations) {
      inserted.organizations += insertedCount(await client.query(`INSERT INTO organizations(id,name,segment,created_at)
        VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`, [org.id, org.name, org.segment, org.createdAt]));
    }
    for (const person of people) {
      inserted.people += insertedCount(await client.query(`INSERT INTO people(id,full_name,organization_name,created_at)
        VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`, [person.id, person.fullName, person.organizationName, person.createdAt]));
    }
    for (const user of resolvedUsers) {
      inserted.users += insertedCount(await client.query(`INSERT INTO known_crm_users(user_sub,display_name,realm_roles,provision_source,first_seen_at,last_seen_at)
        VALUES($1,$2,$3::text[],$4,'2026-09-01T08:00:00Z','2026-09-01T08:00:00Z') ON CONFLICT(user_sub) DO NOTHING`, [user.sub, user.name, user.roles, seedSource]));
      if (user.roles.includes('kam')) {
        inserted.kamDirectory += insertedCount(await client.query(`INSERT INTO kam_directory(user_sub,display_name,enabled,provision_source,updated_at)
          VALUES($1,$2,true,$3,'2026-09-01T08:00:00Z') ON CONFLICT(user_sub) DO NOTHING`, [user.sub, user.name, seedSource]));
      }
    }
    if (options.upgradeLegacyRows !== false) await migrateSeedSubjectReferences(client, resolvedUsers);
    for (const activity of activities) {
      inserted.activities += insertedCount(await client.query(`INSERT INTO activities(
        id,kind,title,origin,route_version,organization_id,person_id,stage_key,owner_sub,owner_name,priority,created_at,updated_at
      ) VALUES($1,$2,$3,'manual',$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`, [
        activity.id, activity.kind, activity.title, activity.routeVersion, activity.organizationId, activity.personId,
        activity.stageKey, subFor(activity.owner), activity.owner.name, activity.priority, activity.createdAt, activity.updatedAt,
      ]));
    }
    inserted.universityContractLicenses += await seedUniversityContractLicenses(client, subFor);
    for (const [activityId, productId] of activityProducts) {
      inserted.productLinks += insertedCount(await client.query(`INSERT INTO activity_products(activity_id,product_id)
        VALUES($1,$2) ON CONFLICT(activity_id,product_id) DO NOTHING`, [activityId, productId]));
    }
    for (const [activityId, programId] of activityPrograms) {
      inserted.programLinks += insertedCount(await client.query(`INSERT INTO activity_programs(activity_id,program_id)
        VALUES($1,$2) ON CONFLICT(activity_id,program_id) DO NOTHING`, [activityId, programId]));
    }
    for (const plan of corporatePlans) {
      inserted.corporatePlans += insertedCount(await client.query(`INSERT INTO corporate_activity_plans(
        activity_id,program_mode,requested_places,brief,methodologist,proposed,agreed,approval,revision,updated_at,actor_sub,actor_name
      ) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12)
        ON CONFLICT(activity_id) DO NOTHING`, [
        plan.activity.id, plan.programMode, plan.requestedPlaces, JSON.stringify(plan.brief), JSON.stringify(plan.methodologist),
        JSON.stringify(plan.proposed), JSON.stringify(plan.agreed), JSON.stringify(plan.approval), plan.revision,
        plan.updatedAt, subFor(plan.actor), plan.actor.name,
      ]));
    }
    for (const step of universitySteps) {
      inserted.universitySteps += insertedCount(await client.query(`INSERT INTO activity_university_steps(
        activity_id,step_id,status,note,evidence_reference,evidence_source,actor_sub,actor_name,updated_at,revision
      ) VALUES($1,$2,$3,$4,NULL,NULL,$5,$6,$7,1) ON CONFLICT(activity_id,step_id) DO NOTHING`, [
        step.activity.id, step.stepId, step.status, step.note, subFor(step.activity.owner), step.activity.owner.name, step.updatedAt,
      ]));
    }
    for (const task of seedTasks) {
      inserted.tasks += insertedCount(await client.query(`INSERT INTO tasks(id,activity_id,title,due_at,status,owner_sub,owner_name,completed_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`, [
        task.id, task.activityId, task.title, task.dueAt, task.status, subFor(task.owner), task.owner.name, task.completedAt, task.createdAt,
      ]));
    }
    for (const event of seedEvents) {
      inserted.history += insertedCount(await client.query(`INSERT INTO activity_events(id,activity_id,event_type,summary,details,actor_sub,actor_name,created_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT(id) DO NOTHING`, [
        event.id, event.activity.id, event.type, event.summary, JSON.stringify(event.details), subFor(event.actor), event.actor.name, event.at,
      ]));
    }

    await verifySeedRows(client, resolvedUsers, { tasks: seedTasks, events: seedEvents, kamProvisionSources: options.kamProvisionSources ?? [SEED_SOURCE, seedSource, 'local-keycloak-provisioning', 'local-load-harness'] });
    await verifyUniversityContractLicenses(client, resolvedUsers);
    if (options.verifyExtra) await options.verifyExtra(client, { resolvedUsers, subFor });
    await client.query('COMMIT');
    return inserted;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function verifySeedRows(client, resolvedUsers, options = {}) {
  const expectedTasks = options.tasks ?? tasks;
  const expectedEvents = options.events ?? events;
  const subFor = (user) => resolvedUsers.find((candidate) => candidate.username === user.username)?.sub ?? user.sub;
  const checks = [
    ['organizations', organizations.map((row) => row.id)],
    ['people', people.map((row) => row.id)],
    ['activities', activities.map((row) => row.id)],
    ['tasks', expectedTasks.map((row) => row.id)],
    ['activity_events', expectedEvents.map((row) => row.id)],
  ];
  for (const [table, ids] of checks) {
    const result = await client.query(`SELECT count(*)::integer AS count FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
    if (Number(result.rows[0]?.count) !== ids.length) throw new Error(`Seed verification failed for ${table}.`);
  }
  const organizationRows = await client.query('SELECT id,name,segment FROM organizations WHERE id=ANY($1::uuid[])', [organizations.map((org) => org.id)]);
  if (organizationRows.rowCount !== organizations.length || organizations.some((expected) => {
    const row = organizationRows.rows.find((candidate) => candidate.id === expected.id);
    return !row || row.name !== expected.name || row.segment !== expected.segment;
  })) throw new Error('Seed verification found a conflicting synthetic organization identity.');
  const roleRows = await client.query(`SELECT user_sub, display_name, realm_roles FROM known_crm_users WHERE user_sub = ANY($1::text[])`, [resolvedUsers.map((user) => user.sub)]);
  if (roleRows.rowCount !== resolvedUsers.length || resolvedUsers.some((expected) => {
    const row = roleRows.rows.find((candidate) => candidate.user_sub === expected.sub);
    const appRoles = Array.isArray(row?.realm_roles) ? row.realm_roles.filter((role) => ['kam', 'manager', 'admin'].includes(role)).sort() : [];
    return !row || row.display_name !== expected.name || JSON.stringify(appRoles) !== JSON.stringify([...expected.roles].sort());
  })) throw new Error('Seed verification failed for the local Keycloak role profiles; existing rows were preserved.');
  const expectedKams = resolvedUsers.filter((user) => user.roles.includes('kam'));
  const kamRows = await client.query('SELECT user_sub, display_name, enabled, provision_source FROM kam_directory WHERE user_sub=ANY($1::text[])', [expectedKams.map((user) => user.sub)]);
  if (kamRows.rowCount !== expectedKams.length || expectedKams.some((expected) => {
    const row = kamRows.rows.find((candidate) => candidate.user_sub === expected.sub);
    return !row || row.display_name !== expected.name || row.enabled !== true
      || !(options.kamProvisionSources ?? [SEED_SOURCE, 'local-keycloak-provisioning', 'local-load-harness']).includes(row.provision_source);
  })) throw new Error('Seed verification failed for synthetic KAM directory rows; existing data was preserved.');

  const activityKinds = await client.query('SELECT id, kind, owner_sub FROM activities WHERE id = ANY($1::uuid[])', [activities.map((activity) => activity.id)]);
  if (activityKinds.rowCount !== activities.length || activities.some((expected) => {
    const row = activityKinds.rows.find((candidate) => candidate.id === expected.id);
    return !row || row.kind !== expected.kind || row.owner_sub !== subFor(expected.owner);
  })) {
    throw new Error('Seed verification found a conflicting activity kind or owner; existing data was preserved.');
  }
  const scopedOwners = await client.query(`SELECT count(*)::integer AS count FROM activities a
    JOIN known_crm_users u ON u.user_sub=a.owner_sub
    JOIN kam_directory k ON k.user_sub=a.owner_sub AND k.enabled=true
    WHERE a.id=ANY($1::uuid[]) AND u.realm_roles @> ARRAY['kam']::text[]`, [activities.map((activity) => activity.id)]);
  if (Number(scopedOwners.rows[0]?.count) !== activities.length) throw new Error('Some seeded activities are not owned by an enabled synthetic KAM.');

  const kinds = await client.query('SELECT kind,count(*)::integer AS count FROM activities WHERE id=ANY($1::uuid[]) GROUP BY kind', [activities.map((activity) => activity.id)]);
  const actualKinds = Object.fromEntries(kinds.rows.map((row) => [row.kind, Number(row.count)]));
  const expectedKinds = { university: 4, corporate: 4, individual: 3 };
  if (Object.entries(expectedKinds).some(([kind, count]) => actualKinds[kind] !== count)) throw new Error('Seed verification failed for activity process totals.');
  const owners = await client.query('SELECT owner_sub,count(*)::integer AS count FROM activities WHERE id=ANY($1::uuid[]) GROUP BY owner_sub', [activities.map((activity) => activity.id)]);
  const ownerCounts = Object.fromEntries(owners.rows.map((row) => [row.owner_sub, Number(row.count)]));
  const expectedOwnerCounts = { [subFor(users[0])]: 6, [subFor(users[1])]: 5 };
  if (Object.entries(expectedOwnerCounts).some(([owner, count]) => ownerCounts[owner] !== count)) throw new Error('Seed verification failed for KAM ownership distribution.');

  const orgSegments = await client.query('SELECT segment,count(*)::integer AS count FROM organizations WHERE id=ANY($1::uuid[]) GROUP BY segment', [organizations.map((org) => org.id)]);
  const expectedSegments = { university: 2, company: 2 };
  const actualSegments = Object.fromEntries(orgSegments.rows.map((row) => [row.segment, Number(row.count)]));
  if (organizations.length !== 4 || Object.entries(expectedSegments).some(([segment, count]) => actualSegments[segment] !== count)) {
    throw new Error('Seed verification failed for organization segment totals.');
  }

  const taskStatuses = await client.query('SELECT status,count(*)::integer AS count FROM tasks WHERE id=ANY($1::uuid[]) GROUP BY status', [expectedTasks.map((task) => task.id)]);
  const actualTaskStatuses = Object.fromEntries(taskStatuses.rows.map((row) => [row.status, Number(row.count)]));
  const expectedTaskStatuses = Object.fromEntries([...new Set(expectedTasks.map((task) => task.status))]
    .map((status) => [status, expectedTasks.filter((task) => task.status === status).length]));
  if (Object.entries(expectedTaskStatuses).some(([status, count]) => actualTaskStatuses[status] !== count)
    || Object.keys(actualTaskStatuses).some((status) => expectedTaskStatuses[status] !== actualTaskStatuses[status])) {
    throw new Error('Seed verification failed for task status totals.');
  }
  const taskHistory = await client.query(`SELECT details->>'taskId' AS task_id,event_type FROM activity_events
    WHERE activity_id=ANY($1::uuid[]) AND event_type IN ('task_created','task_completed')`, [activities.map((activity) => activity.id)]);
  const taskEvents = new Map();
  for (const row of taskHistory.rows) {
    const found = taskEvents.get(row.task_id) ?? new Set();
    found.add(row.event_type);
    taskEvents.set(row.task_id, found);
  }
  if (expectedTasks.some((task) => !taskEvents.get(task.id)?.has('task_created') || (task.status === 'done' && !taskEvents.get(task.id)?.has('task_completed'))
    || (task.status !== 'done' && taskEvents.get(task.id)?.has('task_completed')))) {
    throw new Error('Seed verification found a task without matching history.');
  }
  const taskRelations = await client.query('SELECT id, activity_id, owner_sub FROM tasks WHERE id = ANY($1::uuid[])', [expectedTasks.map((task) => task.id)]);
  if (taskRelations.rowCount !== expectedTasks.length || expectedTasks.some((expected) => {
    const row = taskRelations.rows.find((candidate) => candidate.id === expected.id);
    return !row || row.activity_id !== expected.activityId || row.owner_sub !== subFor(expected.owner);
  })) {
    throw new Error('Seed verification found a conflicting task owner or activity relation; existing data was preserved.');
  }
  const eventRelations = await client.query('SELECT id, activity_id FROM activity_events WHERE id = ANY($1::uuid[])', [expectedEvents.map((event) => event.id)]);
  if (eventRelations.rowCount !== expectedEvents.length || expectedEvents.some((expected) => eventRelations.rows.find((row) => row.id === expected.id)?.activity_id !== expected.activity.id)) {
    throw new Error('Seed verification found a conflicting history identity; existing data was preserved.');
  }

  for (const [table, foreignKey, pairs] of [
    ['activity_products', 'product_id', activityProducts],
    ['activity_programs', 'program_id', activityPrograms],
  ]) {
    for (const [activityId, catalogId] of pairs) {
      const found = await client.query(`SELECT 1 FROM ${table} WHERE activity_id=$1 AND ${foreignKey}=$2`, [activityId, catalogId]);
      if (!found.rowCount) throw new Error(`Seed verification failed for ${table} catalog links.`);
    }
  }
  const plans = await client.query('SELECT activity_id,revision,actor_sub FROM corporate_activity_plans WHERE activity_id=ANY($1::uuid[])', [corporatePlans.map((plan) => plan.activity.id)]);
  if (plans.rowCount !== corporatePlans.length || corporatePlans.some((plan) => !plans.rows.some((row) => row.activity_id === plan.activity.id && Number(row.revision) === plan.revision && row.actor_sub === subFor(plan.actor)))) {
    throw new Error('Seed verification failed for corporate plan rows.');
  }
  const steps = await client.query('SELECT activity_id,step_id,status,note FROM activity_university_steps WHERE activity_id=ANY($1::uuid[])', [universitySteps.map((step) => step.activity.id)]);
  if (steps.rowCount < universitySteps.length || universitySteps.some((step) => !steps.rows.some((row) => row.activity_id === step.activity.id && row.step_id === step.stepId && row.status === step.status && row.note === step.note))) {
    throw new Error('Seed verification failed for university progress rows.');
  }
}

export async function seedSyntheticDemoRows(client, resolvedSubjects, options = {}) {
  return seed(client, resolvedSubjects, options);
}

export async function applySyntheticDemo() {
  const config = await localConfig();
  const resolvedSubjects = await resolveLocalKeycloakSubjects({
    baseUrl: config.keycloakUrl, adminUser: config.keycloakAdminUser, adminPassword: config.keycloakAdminPassword,
  });
  const database = await ensureDemoDatabase(config.bootstrapUrl);
  await runMigrations(config.databaseUrl);
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const rows = await seed(client, resolvedSubjects);
    return { database: DEMO_DATABASE, createdDatabase: database.created, inserted: rows, fixture: { organizations: organizations.length, universityOrganizations: 2, corporateOrganizations: 2, people: people.length, processes: ['university', 'corporate', 'individual'], roles: ['kam', 'manager', 'admin'], kamOwners: 2, activities: activities.length, tasks: tasks.length, history: events.length, productLinks: activityProducts.length, programLinks: activityPrograms.length, corporatePlans: corporatePlans.length, universitySteps: universitySteps.length, universityContractLicenses: universityContractLicenses.length }, lmsFacts: 0 };
  } finally {
    await client.end();
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (options.help) { help(); return; }
  if (options.dryRun) {
    console.log(JSON.stringify({ mode: 'dry-run', database: DEMO_DATABASE, endpoint: `${LOCAL_HOST}:${LOCAL_PORT}`, marker: DEMO_MARKER, processes: ['university', 'corporate', 'individual'], roles: ['kam', 'manager', 'admin'], plannedRows: { organizations: organizations.length, universityOrganizations: 2, corporateOrganizations: 2, people: people.length, roleProfiles: users.length, kamDirectory: 2, activities: activities.length, tasks: tasks.length, history: events.length, productLinks: activityProducts.length, programLinks: activityPrograms.length, corporatePlans: corporatePlans.length, universitySteps: universitySteps.length, universityContractLicenses: universityContractLicenses.length }, lmsFacts: 0 }, null, 2));
    return;
  }
  console.log(JSON.stringify(await applySyntheticDemo(), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
