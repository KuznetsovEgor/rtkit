import { useMemo, useState } from 'react';
import './education-products.css';

type Offering = { label: string; url: string };
type EducationItem = {
  id: string;
  name: string;
  kind: 'Решение' | 'Программа';
  audience: string;
  description: string;
  when: string;
  note: string;
  offerings: Offering[];
};

// Каталог составлен по публичным карточкам LMS и исследовательскому реестру
// RTK_CRM_Research_Registers.xlsx (лист «08 Программы»). Ссылки ведут на
// карточки предложений и публикации, не выдаются за презентации.
const ITEMS: EducationItem[] = [
  {
    id: 'akola', name: 'Акола', kind: 'Решение', audience: 'Вузы: студенты и преподаватели',
    description: 'Платформа веб-разработки. В открытых материалах есть университетская программа для студентов и отдельное предложение переподготовки для преподавателей.',
    when: 'Когда вуз обсуждает практическое обучение веб-разработке или интеграцию программы в учебный план. Перед предложением уточните целевую аудиторию и формат.',
    note: 'Публикация компании сообщала о передаче программы 12 вузам и продолжавшейся интеграции; это не подтверждает запуск во всех вузах или выпуск слушателей.',
    offerings: [
      { label: 'Публикация о программе для студентов', url: 'https://www.company.rt.ru/press/news/d475841/' },
      { label: 'Карточка программы для преподавателей', url: 'https://lms.edupro.rt.ru/local/crw/course.php?id=114' },
    ],
  },
  {
    id: 'basis', name: 'Базис', kind: 'Решение', audience: 'Преподаватели и технические специалисты вузов',
    description: 'Решение представлено в каталоге обучения через программу «DevOps-инженер — Базис». В описании курса речь о подготовке по DevOps.',
    when: 'Когда вузу нужна подготовка преподавателей или технических специалистов по DevOps. Сверьте актуальность набора и применимость к конкретной инфраструктуре.',
    note: 'В публичной карточке — повышение квалификации на 72 академических часа. Наличие предложения не подтверждает текущий набор или результаты потока.',
    offerings: [{ label: 'Карточка программы в LMS', url: 'https://lms.edupro.rt.ru/local/crw/course.php?id=118' }],
  },
  {
    id: 'aurora', name: 'Аврора', kind: 'Решение', audience: 'Преподаватели',
    description: 'Мобильная платформа; образовательный маршрут включает курс по созданию приложений на Qt Quick и QML.',
    when: 'Когда преподаватели рассматривают мобильную разработку и включение Qt Quick в обучение. Отдельно проверьте, подходит ли предложение нужной группе слушателей.',
    note: 'Карточка программы для преподавателей указывает 144 академических часа. Эти параметры нельзя автоматически переносить на другие версии курса.',
    offerings: [
      { label: 'Карточка программы в LMS', url: 'https://lms.edupro.rt.ru/local/crw/course.php?id=116' },
      { label: 'Образовательный раздел вендора', url: 'https://auroraos.ru/education' },
    ],
  },
  {
    id: 'web3gate', name: 'RT.Web3Gate', kind: 'Решение', audience: 'Вузы; аудиторию конкретного курса нужно уточнить',
    description: 'Решение упоминается в программе по технологиям распределённого реестра. Карточка курса перечисляет Solidity и индивидуальный проект.',
    when: 'Когда вуз рассматривает направление распределённых реестров и просит учебный материал по теме. До предложения уточните целевую аудиторию: описание курса расходится с его заголовком.',
    note: 'Публичная карточка указывает 108 часов, но содержит неоднозначность между преподавателями и студентами.',
    offerings: [{ label: 'Карточка программы в LMS', url: 'https://lms.edupro.rt.ru/local/crw/course.php?id=111' }],
  },
  {
    id: 'akola-university', name: 'Акола · веб-разработка для студентов', kind: 'Программа', audience: 'Студенты вузов',
    description: 'Университетская программа веб-разработки. В публикации от ноября 2025 года указан объём 270 часов.',
    when: 'Когда вуз обсуждает цифровые кафедры, практические ИТ-дисциплины или интеграцию веб-разработки в учебный план.',
    note: 'Компания сообщала о передаче программы 12 вузам. Указанные в публикации 3 500 студентов и 125 преподавателей были планом, не фактом завершения.',
    offerings: [{ label: 'Публикация компании', url: 'https://www.company.rt.ru/press/news/d475841/' }],
  },
  {
    id: 'akola-rea', name: 'Акола · Цифровые кафедры РЭУ', kind: 'Программа', audience: 'Студенты не-ИТ направлений РЭУ им. Г. В. Плеханова',
    description: 'Маршрут обучения веб-разработке на платформе Акола в рамках цифровых кафедр РЭУ.',
    when: 'При обращении РЭУ или обсуждении отдельной траектории для студентов не-ИТ направлений. Передайте вузу детали актуального набора.',
    note: 'В публикации вуза описан девятимесячный маршрут. Продолжающееся обучение заявлялось вузом; индивидуальные результаты не проверены.',
    offerings: [
      { label: 'Объявление о наборе РЭУ', url: 'https://www.rea.ru/news/59615-tsifrovyie-kafedryi-v-plehanovskom-universitete-startuet-novyiy-potok-obucheniya' },
      { label: 'Карточка курса в LMS РЭУ', url: 'https://lmsdo.rea.ru/enrol/index.php?id=1283' },
    ],
  },
  {
    id: 'low-code', name: 'Low-code анализ данных', kind: 'Программа', audience: 'Преподаватели и слушатели — уточнить по карточке потока',
    description: 'Направление присутствует в публичном каталоге программ ИТ Школы РТК.',
    when: 'Когда вуз запрашивает учебный курс по анализу данных с low-code подходом. Сначала уточните аудиторию, программу и формат текущего предложения.',
    note: 'Объём и конкретный вуз для предложения в исследовательском реестре не подтверждены.',
    offerings: [{ label: 'Каталог программ LMS', url: 'https://lms.edupro.rt.ru/local/crw/' }],
  },
  {
    id: 'it-projects', name: 'Управление ИТ-проектами', kind: 'Программа', audience: 'Зависит от отдельного набора',
    description: 'Учебное направление, которое встречается в каталоге программ и отдельных наборах.',
    when: 'Когда заказчик формулирует запрос на развитие компетенций управления проектами. Сверьте оператора, условия набора и целевую аудиторию.',
    note: 'Единую длительность и маршрут нельзя переносить между разными предложениями с похожим названием.',
    offerings: [
      { label: 'Каталог программ LMS', url: 'https://lms.edupro.rt.ru/local/crw/' },
      { label: 'Информация о программе набора', url: 'https://www.tgu-trud.ru/program/itprojectmanagement' },
    ],
  },
  {
    id: 'future-code', name: 'Код будущего · C++ и Python', kind: 'Программа', audience: 'Ученики 8–11 классов и студенты СПО',
    description: 'Школьный и СПО маршрут обучения программированию с набором через Госуслуги и очными площадками.',
    when: 'Когда школа или организация СПО интересуется федеральным маршрутом обучения. Сначала проверьте набор, регион и участие конкретной площадки.',
    note: 'В публичном сообщении 145 академических часов и около 3 000 мест представлены как параметры/план; конкретные договоры площадок не проверены.',
    offerings: [{ label: 'Публикация компании', url: 'https://www.company.rt.ru/press/news/d479335/' }],
  },
];

type Filter = 'all' | 'programs' | 'solutions';

const PRODUCT_ICONS: Record<string, string> = {
  akola: 'https://lukit.ru/assets/favicon--jvk22SX.svg',
  basis: 'https://basis.ru/favicon.ico',
  aurora: 'https://static.tildacdn.com/tild6339-3435-4530-a331-353638653064/_fav.png',
  web3gate: 'https://www.web3gate.ru/favicon.ico',
};

function ProductMark({ item }: { item: EducationItem }) {
  const productId = item.id.startsWith('akola') ? 'akola' : item.id;
  const icon = PRODUCT_ICONS[productId];
  if (icon) return <span className="education-product-mark is-logo" aria-hidden="true"><img src={icon} alt="" loading="lazy" onError={(event) => { event.currentTarget.parentElement?.classList.add('is-missing'); }} /><span className="education-product-fallback">{item.name.slice(0, 1)}</span></span>;
  return <span className="education-product-mark is-program" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5h6a3 3 0 0 1 3 3v11a3 3 0 0 0-3-3H4zM20 5.5h-4a3 3 0 0 0-3 3v11a3 3 0 0 1 3-3h4z" /></svg></span>;
}

export function EducationProducts() {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const visible = useMemo(() => ITEMS.filter((item) => {
    const matchesFilter = filter === 'all' || (filter === 'programs' ? item.kind === 'Программа' : item.kind === 'Решение');
    const text = `${item.name} ${item.audience} ${item.description}`.toLocaleLowerCase('ru');
    return matchesFilter && text.includes(search.trim().toLocaleLowerCase('ru'));
  }), [filter, search]);

  return <div className="education-products-page">
    <header className="page-heading education-products-heading">
      <div><div className="eyebrow">КАТАЛОГ ДЛЯ РАБОТЫ С КЛИЕНТАМИ</div><h1>Продукты и программы</h1><p>Проверенные предложения и короткие ориентиры: кому подходят и когда их обсуждать.</p></div>
    </header>
    <section className="education-products-tools" aria-label="Фильтры каталога">
      <div className="education-products-filters" role="group" aria-label="Тип материалов">
        {[['all', 'Все'], ['programs', 'Программы'], ['solutions', 'ИТ-решения']].map(([key, label]) => <button key={key} type="button" className={filter === key ? 'selected' : ''} aria-pressed={filter === key} onClick={() => setFilter(key as Filter)}>{label}</button>)}
      </div>
      <label className="field education-products-search"><span>Поиск</span><input type="search" value={search} maxLength={100} placeholder="Название, тема или аудитория" onChange={(event) => setSearch(event.target.value)} /></label>
      <span className="education-products-count" aria-live="polite">{visible.length} {visible.length === 1 ? 'материал' : visible.length < 5 ? 'материала' : 'материалов'}</span>
    </section>
    {visible.length ? <div className="education-products-grid">{visible.map((item) => <article className="education-product-card" key={item.id}>
      <div className="education-product-card-top"><span className={`education-product-type ${item.kind === 'Программа' ? 'is-program' : ''}`}>{item.kind}</span><ProductMark item={item} /></div>
      <h2>{item.name}</h2><p className="education-product-audience"><span>Для кого</span>{item.audience}</p>
      <p className="education-product-description">{item.description}</p>
      <details className="education-product-details">
        <summary>Подробнее</summary>
        <div className="education-product-detail-body">
          <section><h3>Когда предлагать</h3><p>{item.when}</p></section>
          <section><h3>Что известно</h3><p>{item.note}</p></section>
          <section><h3>Материалы</h3><p className="education-product-presentation">Презентация готовится</p>
            <ul>{item.offerings.map((offering) => <li key={offering.url}><a href={offering.url} target="_blank" rel="noreferrer">{offering.label}<span aria-hidden="true"> ↗</span></a></li>)}</ul>
          </section>
        </div>
      </details>
    </article>)}</div> : <section className="panel education-products-empty"><h2>Ничего не найдено</h2><p>Попробуйте изменить запрос или выбрать другой раздел.</p></section>}
    <p className="education-products-footnote">Ссылки ведут на публичные карточки программ и публикации. Это не презентации; условия конкретного запуска нужно сверять отдельно.</p>
  </div>;
}
