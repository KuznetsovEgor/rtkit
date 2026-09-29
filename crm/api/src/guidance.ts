import { DomainError, type ActivityKind, type GuidanceArticleContent, type GuidanceStageSnapshot } from './domain.js';

export interface StageArticle {
  title: string;
  summary: string;
  focus: string;
  checks: string[];
  boundary: string;
  draftMessage: string;
}

export interface StageGuidanceEntry extends StageArticle {
  recommendationWhenNoOpenTask: string;
}

export const guidanceMetadata = {
  source: 'Локальная проектная справка CRM',
  version: '0.1.0',
  reviewDate: '2026-09-27',
  projectStatus: 'provisional',
  statusLabel: 'Проектная редакция · требует предметной проверки',
} as const;

// This local catalog is the single source for stage instruction text until a
// reviewed, editable instruction store is part of a later package.
export const stageArticles = {
  university: {
    contact: {
      title: 'Первичный контакт',
      summary: 'Установите контакт с вузом и выясните, кто отвечает за нужное направление.',
      focus: 'Понять актуальность сотрудничества и согласовать следующий разговор.',
      checks: ['Запишите роль и контактное лицо, если они известны.', 'Уточните, какие программы или продукты интересуют вуз.'],
      boundary: 'Не считайте интерес подтверждением договорённости или готовности к запуску.',
      draftMessage: 'Здравствуйте! Подскажите, пожалуйста, актуально ли сейчас обсуждение программ или ИТ-продуктов для вашего вуза? Если да, предлагаю согласовать удобный следующий разговор.',
      recommendationWhenNoOpenTask: 'Свяжитесь с представителем вуза и зафиксируйте актуальность программ.',
    },
    meeting: {
      title: 'Встреча и потребность',
      summary: 'Обсудите потребность вуза и договоритесь о конкретном продолжении работы.',
      focus: 'Зафиксировать участников, темы разговора и подтверждённые договорённости.',
      checks: ['Сверьте интересующие программы и предполагаемый формат.', 'Запишите согласованные материалы или дату следующего контакта.'],
      boundary: 'Не добавляйте в историю неподтверждённые сроки, объёмы или решения.',
      draftMessage: 'Здравствуйте! Предлагаю сверить потребность вуза и договориться о следующем шаге. Какие темы и участники важны для обсуждения?',
      recommendationWhenNoOpenTask: 'Согласуйте с вузом встречу или следующий контакт по потребности.',
    },
    documents: {
      title: 'Документы и согласование',
      summary: 'Сопроводите обмен документами и согласование условий сотрудничества.',
      focus: 'Отслеживать, что уже передано, что получено и по каким пунктам нужен ответ.',
      checks: ['Фиксируйте факт передачи или получения отдельно от ожидания ответа.', 'Запишите замечания и ответственных только по подтверждённым данным.'],
      boundary: 'Передача документа сама по себе не означает его согласование или подписание.',
      draftMessage: 'Здравствуйте! Подскажите, пожалуйста, удалось ли посмотреть переданные документы? Если есть замечания или нужны дополнительные материалы, зафиксируем их отдельно.',
      recommendationWhenNoOpenTask: 'Уточните у вуза состояние согласования и нужные корректировки.',
    },
    implementation: {
      title: 'Внедрение',
      summary: 'Сопровождайте передачу в работу и фиксируйте организационные договорённости.',
      focus: 'Поддерживать связь по запуску, преподавателям и актуальности материалов.',
      checks: ['Записывайте подтверждённые даты и ответственных.', 'Отмечайте обновления программ или материалов как отдельные события.'],
      boundary: 'CRM хранит ход взаимодействия, а учебные факты остаются в LMS.',
      draftMessage: 'Здравствуйте! Хотел уточнить, есть ли сейчас организационные вопросы по внедрению, преподавателям или материалам. Подскажите, что стоит проверить в первую очередь?',
      recommendationWhenNoOpenTask: 'Уточните у вуза ближайшую потребность по внедрению или материалам.',
    },
    closed: {
      title: 'Завершено',
      summary: 'Работа по этой активности завершена; история сохраняет её фактический ход.',
      focus: 'При необходимости сверяться с сохранёнными событиями и итогами.',
      checks: ['Используйте историю для проверки зафиксированных договорённостей.', 'Новую работу ведите в отдельной активности.'],
      boundary: 'Завершённую активность нельзя считать открытой только из-за новой потребности.',
      draftMessage: 'Здравствуйте! Возвращаюсь к итогам нашего взаимодействия. Если появится новая потребность, обсудим её в рамках отдельного запроса.',
      recommendationWhenNoOpenTask: 'Используйте сохранённую историю как итог этой активности.',
    },
  },
  individual: {
    request: {
      title: 'Новая заявка',
      summary: 'Разберите запрос физлица и уточните его цель обучения.',
      focus: 'Понять интересующую программу, формат и удобный способ связи.',
      checks: ['Проверьте, какие контактные сведения уже указаны.', 'Уточните потребность до предложения конкретного решения.'],
      boundary: 'Заявка не подтверждает оплату, зачисление или начало обучения.',
      draftMessage: 'Здравствуйте! Расскажите, пожалуйста, какой результат вы хотите получить от обучения и какой формат вам удобен. Это поможет понять, какие варианты стоит рассмотреть.',
      recommendationWhenNoOpenTask: 'Свяжитесь с человеком и уточните запрос на обучение.',
    },
    consultation: {
      title: 'Консультация',
      summary: 'Помогите человеку соотнести его цель с доступным предложением.',
      focus: 'Обсудить программу и ответы на вопросы, которые уже возникли.',
      checks: ['Запишите интерес к конкретному курсу, если он назван.', 'Отдельно зафиксируйте согласованный следующий контакт.'],
      boundary: 'Не обещайте наличие места или оплату без подтверждающих данных.',
      draftMessage: 'Здравствуйте! Какие вопросы по программе остались после консультации? Я уточню доступные сведения и предложу следующий организационный шаг.',
      recommendationWhenNoOpenTask: 'Свяжитесь с человеком и ответьте на оставшиеся вопросы по программе.',
    },
    conditions: {
      title: 'Условия обучения',
      summary: 'Сверьте выбранную программу и организационные условия индивидуального запроса.',
      focus: 'Разделить обучающегося, заказчика и плательщика; компания-плательщик не меняет индивидуальный маршрут.',
      checks: ['Запишите только согласованные условия и то, что ещё нужно уточнить.', 'Не выводите факт оплаты из внешнего номера заказа или названия файла.'],
      boundary: 'CRM не ведёт оплату или бухгалтерский учёт и не подтверждает зачисление.',
      draftMessage: 'Здравствуйте! Предлагаю сверить выбранную программу и организационные условия. Подскажите, пожалуйста, что уже согласовано, а что ещё нужно уточнить?',
      recommendationWhenNoOpenTask: 'Подтвердите с человеком программу и следующий организационный шаг.',
    },
    lms_handoff: {
      title: 'Передача в LMS',
      summary: 'Сопроводите передачу подтверждённого заказа в систему обучения.',
      focus: 'Проверить источник заказа и сохранить ссылку на внешнее подтверждение.',
      checks: ['Различайте готовый заказ, передачу в LMS и факт зачисления.', 'Учебные сведения показываются только из внешнего источника.'],
      boundary: 'Стадия передачи сама по себе не означает зачисление или начало обучения; CRM не создаёт запись в LMS.',
      draftMessage: 'Здравствуйте! Подскажите, пожалуйста, подтверждена ли передача заказа в систему обучения и у кого можно уточнить её результат?',
      recommendationWhenNoOpenTask: 'Сверьте, кто выполняет передачу в LMS и где проверить её результат.',
    },
    exceptions: {
      title: 'Исключения и возврат',
      summary: 'Разберите возврат или несовпадение во внешней передаче, сохраняя исходные данные.',
      focus: 'Указать источник расхождения и ссылку на запись, которую нужно проверить.',
      checks: ['Не исправляйте внешние учебные факты в CRM.', 'Для коррекции направляйте к владельцу данных в LMS.'],
      boundary: 'CRM показывает ссылку на внешний факт, но не заменяет и не переписывает его.',
      draftMessage: 'Здравствуйте! В передаче обнаружено расхождение, которое нужно проверить. Подскажите, пожалуйста, кто отвечает за эту запись в системе обучения и какой источник сверить?',
      recommendationWhenNoOpenTask: 'Уточните у владельца LMS, что именно требует проверки или повторной передачи.',
    },
    result: {
      title: 'Итог сопровождения',
      summary: 'Завершите организационную работу CRM, оставив внешний учебный итог в LMS.',
      focus: 'Сохранить фактическую коммуникацию и ссылку на доступное внешнее подтверждение.',
      checks: ['Закрывайте только работу CRM.', 'Проверяйте актуальность внешней ссылки и источника.'],
      boundary: 'Закрытие этой активности не означает успешное завершение обучения.',
      draftMessage: 'Здравствуйте! Организационное сопровождение по этой заявке завершено. При появлении нового вопроса напишите, пожалуйста, отдельно, чтобы мы могли корректно его зафиксировать.',
      recommendationWhenNoOpenTask: 'Сверьтесь с историей CRM и доступной read-only проекцией из LMS.',
    },
    enrollment: {
      title: 'Подготовка к обучению',
      summary: 'Сопроводите подтверждённые организационные шаги перед обучением.',
      focus: 'Уточнить, какие сведения или действия ещё нужны для передачи заявки.',
      checks: ['Различайте заявку, оплату и подтверждение зачисления.', 'Записывайте источник внешнего подтверждения, если он поступил.'],
      boundary: 'CRM не подтверждает оплату или зачисление по одному лишь названию заявки.',
      draftMessage: 'Здравствуйте! Предлагаю сверить, какие организационные сведения ещё нужны для передачи заявки. Если у вас есть внешнее подтверждение заказа, подскажите его источник.',
      recommendationWhenNoOpenTask: 'Уточните статус подготовки и следующий подтверждённый шаг.',
    },
    learning: {
      title: 'Обучение',
      summary: 'Сопровождайте коммуникацию во время обучения без дублирования учебного учёта.',
      focus: 'Фиксировать только разрешённые организационные обновления и запросы человека.',
      checks: ['При необходимости уточните статус у ответственного источника.', 'Сохраняйте ссылку и время для полученного внешнего обновления.'],
      boundary: 'Занятия, оценки и завершение обучения принадлежат LMS.',
      draftMessage: 'Здравствуйте! Есть ли организационный вопрос, с которым нужна помощь во время обучения? Учебный статус при необходимости уточним у ответственного источника.',
      recommendationWhenNoOpenTask: 'Проверьте, требуется ли организационный контакт по этой активности.',
    },
    closed: {
      title: 'Завершено',
      summary: 'Работа по этой активности завершена; сохранённая история остаётся доступной.',
      focus: 'При необходимости сверяться с итогом и подтверждёнными событиями.',
      checks: ['Ориентируйтесь на сохранённые события.', 'Для новой потребности используйте отдельную активность.'],
      boundary: 'Закрытие CRM-активности само по себе не является фактом завершения курса.',
      draftMessage: 'Здравствуйте! Организационная работа по обращению завершена. Новые вопросы по обучению можно обсудить отдельно.',
      recommendationWhenNoOpenTask: 'Используйте сохранённую историю как итог этой активности.',
    },
  },
  corporate: {
    qualification: {
      title: 'Потребность компании',
      summary: 'Уточните задачу компании и определите, рассматривается ли готовая программа или доработка.',
      focus: 'Понять ожидаемый результат, аудиторию и контактных участников.',
      checks: ['Запишите только уже названные программы и продукты.', 'Уточните, нужна ли адаптация или новая программа.'],
      boundary: 'Не превращайте неподтверждённую потребность в согласованный заказ.',
      draftMessage: 'Здравствуйте! Чтобы понять подходящий формат работы, расскажите, пожалуйста, какого результата ожидает компания, для какой аудитории и рассматривается ли готовая программа или доработка.',
      recommendationWhenNoOpenTask: 'Уточните ожидаемый результат и подходящий формат работы с компанией.',
    },
    brief: {
      title: 'Бриф и оценка',
      summary: 'Соберите исходные требования, необходимые для оценки адаптации или новой программы.',
      focus: 'Согласовать ожидаемый результат, объём, сроки и критерии приёмки.',
      checks: ['Отмечайте неизвестные пункты как требующие уточнения.', 'Зафиксируйте, кому передан бриф на оценку.'],
      boundary: 'Передача брифа не означает готовую оценку, цену или согласование.',
      draftMessage: 'Здравствуйте! Для подготовки брифа осталось уточнить исходные требования и критерии результата. Какие пункты уже подтверждены, а какие нужно прояснить с вашей стороны?',
      recommendationWhenNoOpenTask: 'Уточните недостающие пункты брифа перед оценкой.',
    },
    approval: {
      title: 'Согласование программы',
      summary: 'Сопровождайте согласование предложенного содержания и условий.',
      focus: 'Разделять версию предложения, замечания и подтверждённые решения.',
      checks: ['Запишите, какие пункты требуют ответа.', 'Фиксируйте согласование только после подтверждения сторон.'],
      boundary: 'Рабочее обсуждение не равно утверждению программы или договора.',
      draftMessage: 'Здравствуйте! Подскажите, пожалуйста, какие замечания к предложению ещё открыты и кто сможет подтвердить согласованное содержание?',
      recommendationWhenNoOpenTask: 'Уточните у компании замечания к предложению и нужный срок ответа.',
    },
    launch: {
      title: 'Подготовка запуска',
      summary: 'Сопроводите подтверждённые организационные действия перед запуском.',
      focus: 'Сверить ответственных, даты и материалы, которые стороны уже подтвердили.',
      checks: ['Фиксируйте каждую готовность по её подтверждённому источнику.', 'Оставляйте учебные данные в LMS.'],
      boundary: 'Подготовка запуска не подтверждает фактическое начало обучения.',
      draftMessage: 'Здравствуйте! Предлагаю сверить подтверждённые организационные шаги перед запуском: ответственных, даты и готовность материалов. Что ещё требует проверки?',
      recommendationWhenNoOpenTask: 'Сверьте с компанией ближайшее организационное действие по запуску.',
    },
    closed: {
      title: 'Завершено',
      summary: 'Работа по этой активности завершена; её фактические события сохранены в истории.',
      focus: 'При необходимости сверяться с итогом и подтверждёнными договорённостями.',
      checks: ['Используйте историю этой активности.', 'Новый запрос компании ведите отдельно.'],
      boundary: 'Закрытая активность не должна переоткрываться из-за нового запроса.',
      draftMessage: 'Здравствуйте! Работа по этому запросу завершена. Если у компании появилась новая потребность, расскажите о ней — зафиксируем отдельную активность.',
      recommendationWhenNoOpenTask: 'Используйте сохранённую историю как итог этой активности.',
    },
  },
} as const satisfies Record<ActivityKind, Record<string, StageGuidanceEntry>>;

const sortedUnique = (values: unknown): string[] => Array.isArray(values)
  ? [...new Set(values.filter((value): value is string => typeof value === 'string'))].sort()
  : [];

export function guidanceStageSnapshot(stage: Record<string, any>): GuidanceStageSnapshot {
  const routes = stage.allowedNextByRoute && typeof stage.allowedNextByRoute === 'object' ? stage.allowedNextByRoute : {};
  return {
    label: String(stage.label ?? ''), ordinal: Number(stage.ordinal ?? 0), terminal: stage.terminal === true,
    allowedNext: sortedUnique(stage.allowedNext),
    allowedNextByRoute: { legacy: sortedUnique(routes.legacy), v2: sortedUnique(routes.v2) },
  };
}

export function guidanceSnapshotMatches(snapshot: GuidanceStageSnapshot | null | undefined, stage: Record<string, any>): boolean {
  if (!snapshot) return false;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]))
      : value;
  return JSON.stringify(canonical(snapshot)) === JSON.stringify(canonical(guidanceStageSnapshot(stage)));
}

export function validateGuidanceArticleContent(value: GuidanceArticleContent): GuidanceArticleContent {
  const limits: [keyof GuidanceArticleContent, number][] = [
    ['title', 120], ['summary', 500], ['focus', 500], ['boundary', 500], ['draftMessage', 1000],
    ['recommendationWhenNoOpenTask', 300],
  ];
  for (const [field, max] of limits) {
    const text = value[field];
    if (typeof text !== 'string' || !text.trim() || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new DomainError(400, 'invalid_guidance_article', 'Заполните текст инструкции в допустимых пределах.');
    }
  }
  if (!Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > 8 || value.checks.some((check) =>
    typeof check !== 'string' || !check.trim() || check.length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(check))) {
    throw new DomainError(400, 'invalid_guidance_article', 'Добавьте от 1 до 8 коротких проверок.');
  }
  return {
    title: value.title.trim(), summary: value.summary.trim(), focus: value.focus.trim(), checks: value.checks.map((check) => check.trim()),
    boundary: value.boundary.trim(), draftMessage: value.draftMessage.trim(), recommendationWhenNoOpenTask: value.recommendationWhenNoOpenTask.trim(),
  };
}

export function findStageArticle(kind: string, stageKey: string): StageGuidanceEntry | null {
  if (!Object.hasOwn(stageArticles, kind)) return null;
  const articles = stageArticles[kind as ActivityKind] as Record<string, StageGuidanceEntry>;
  return articles[stageKey] ?? null;
}

export interface GuidanceTask {
  id: string;
  title: string;
  dueAt: string | Date;
  status: string;
}

function formatDueAt(value: string | Date): string {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date(value));
}

export function makeContextualTip(
  stage: { label: string; terminal: boolean },
  tasks: GuidanceTask[],
  article: StageGuidanceEntry,
  kind = 'university',
  stageKey = 'contact',
  now = new Date(),
) {
  const openTasks = tasks
    .filter((task) => task.status === 'open' && Number.isFinite(new Date(task.dueAt).valueOf()))
    .sort((left, right) => new Date(left.dueAt).valueOf() - new Date(right.dueAt).valueOf());
  const overdueTask = openTasks.find((task) => new Date(task.dueAt).valueOf() < now.valueOf());
  if (overdueTask) {
    return {
      recommendationKey: `task:${overdueTask.id}`,
      recommendation: `Разберите просроченное действие «${overdueTask.title}».`,
      whyNow: `Открытое действие просрочено: срок ${formatDueAt(overdueTask.dueAt)}.`,
    };
  }
  const nextTask = openTasks[0];
  if (nextTask) {
    return {
      recommendationKey: `task:${nextTask.id}`,
      recommendation: `Подготовьтесь к запланированному действию «${nextTask.title}».`,
      whyNow: `Это ближайшее открытое действие со сроком ${formatDueAt(nextTask.dueAt)}.`,
    };
  }
  return {
    recommendationKey: `stage:${kind}:${stageKey}`,
    recommendation: article.recommendationWhenNoOpenTask,
    whyNow: stage.terminal
      ? `Активность находится на завершающей стадии «${stage.label}».`
      : `Открытых действий нет; активность находится на стадии «${stage.label}».`,
  };
}
