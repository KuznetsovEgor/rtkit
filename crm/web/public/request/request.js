const form = document.querySelector('#inquiry-form');
const tabs = [...document.querySelectorAll('[data-tab-kind]')];
const kindInput = form.elements.kind;
const organizationField = document.querySelector('.organization-field');
const organizationLabel = organizationField.firstChild;
const organizationRequiredMark = organizationField.querySelector('span');
const organizationInput = form.elements.organization;
const successCard = document.querySelector('#success-card');
const errorBox = document.querySelector('#form-error');
const submitButton = document.querySelector('#submit-button');
let pendingSubmission = null;
const submissionTimeoutMs = 15_000;

const organizationLabels = { university: 'Название вуза', corporate: 'Название компании' };
const organizationPlaceholders = {
  university: 'Например, Учебный университет',
  corporate: 'Например, Учебная компания',
};
const notePlaceholders = {
  university: 'Например, хотим обсудить практическую программу для студентов',
  corporate: 'Например, хотим обсудить обучение команды аналитике данных',
  individual: 'Например, хочу разобраться в анализе данных и понять, с чего начать',
};

function selectKind(kind) {
  kindInput.value = kind;
  for (const tab of tabs) {
    const selected = tab.dataset.tabKind === kind;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-pressed', String(selected));
  }
  const needsOrganization = kind !== 'individual';
  organizationField.hidden = !needsOrganization;
  organizationInput.required = needsOrganization;
  organizationLabel.textContent = needsOrganization ? organizationLabels[kind] : '';
  organizationInput.placeholder = needsOrganization ? organizationPlaceholders[kind] : '';
  organizationRequiredMark.hidden = !needsOrganization;
  form.elements.note.placeholder = notePlaceholders[kind];
  errorBox.textContent = '';
}

tabs.forEach((tab) => tab.addEventListener('click', () => selectKind(tab.dataset.tabKind)));
document.querySelector('#another-request').addEventListener('click', () => {
  successCard.hidden = true;
  form.hidden = false;
  pendingSubmission = null;
  form.reset();
  selectKind('university');
  form.elements.name.focus();
});

function keyForRetry(payload) {
  // A lost response can follow a committed write. Reuse its key only for the
  // same submitted values; edited values are a different inquiry.
  const fingerprint = JSON.stringify(payload);
  if (!pendingSubmission || pendingSubmission.fingerprint !== fingerprint) {
    pendingSubmission = { fingerprint, key: crypto.randomUUID() };
  }
  return pendingSubmission.key;
}

function validateForm() {
  const { name, email, organization, note } = form.elements;
  const checks = [
    [name, name.value.trim().length >= 2, 'Укажите имя — не менее двух символов.'],
    [email, email.validity.valid && email.value.trim() !== '', 'Укажите корректную электронную почту.'],
    [organization, !organization.required || organization.value.trim().length >= 2,
      kindInput.value === 'university' ? 'Укажите название вуза.' : 'Укажите название компании.'],
    [note, note.value.trim().length >= 8, 'Коротко опишите запрос — не менее восьми символов.'],
  ];
  for (const [field, valid, message] of checks) {
    if (valid) continue;
    errorBox.textContent = message;
    field.focus();
    return false;
  }
  return true;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitButton.disabled) return;
  errorBox.textContent = '';
  if (!validateForm()) return;
  const data = new FormData(form);
  const payload = {
    kind: String(data.get('kind')),
    name: String(data.get('name') ?? '').trim(),
    email: String(data.get('email') ?? '').trim(),
    phone: String(data.get('phone') ?? '').trim(),
    organization: String(data.get('organization') ?? '').trim(),
    note: String(data.get('note') ?? '').trim(),
    honeypot: String(data.get('website') ?? ''),
  };
  payload.idempotencyKey = keyForRetry(payload);
  submitButton.disabled = true;
  submitButton.setAttribute('aria-busy', 'true');
  const originalLabel = submitButton.innerHTML;
  submitButton.textContent = 'Отправляем…';
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), submissionTimeoutMs);
  try {
    const config = window.RTK_DEMO_CONFIG ?? {};
    const localDevApi = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? `${location.protocol}//${location.hostname}:3001` : 'https://api.crm.futura.team';
    const apiBase = String(config.apiBase ?? localDevApi).replace(/\/$/, '');
    const response = await fetch(`${apiBase}/api/public-demo/inquiries`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 400) errorBox.textContent = result.message || 'Проверьте заполнение полей и попробуйте ещё раз.';
      else if (response.status === 429) errorBox.textContent = 'Слишком много отправок. Попробуйте позже.';
      else errorBox.textContent = 'Не удалось отправить заявку. Попробуйте ещё раз чуть позже.';
      if (response.status === 400) pendingSubmission = null;
      return;
    }
    pendingSubmission = null;
    form.hidden = true;
    successCard.hidden = false;
    document.querySelector('#success-copy').textContent = result.duplicate
      ? 'Такая заявка уже есть в CRM — второй экземпляр не создан.'
      : 'Заявка создана в CRM.';
    successCard.focus();
  } catch {
    errorBox.textContent = 'Не удалось связаться с CRM. Данные остались в форме — отправку можно повторить.';
  } finally {
    window.clearTimeout(timeout);
    submitButton.disabled = false;
    submitButton.removeAttribute('aria-busy');
    submitButton.innerHTML = originalLabel;
  }
});

selectKind('university');
