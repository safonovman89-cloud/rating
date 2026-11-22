const form = document.querySelector('#comparison-form');
const settings = document.querySelector('#settings');
const period = document.querySelector('#period');
const baseline = document.querySelector('#baseline');
const focus = document.querySelector('#focus');
const subjects = document.querySelector('#subjects');
const status = document.querySelector('#status');
const output = document.querySelector('#report');
const retry = document.querySelector('#retry');
let catalog;

function element(tag, text, style) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (style) node.className = style;
  return node;
}

function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

async function request(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error('Сервер недоступен. Повторите запрос.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Запрос не выполнен.');
  return result;
}

function selected() {
  return [...subjects.querySelectorAll('input:checked')].map(input => input.value);
}

function updateOptions() {
  const previous = baseline.value;
  baseline.replaceChildren(new Option('Без базы', ''), ...catalog.periods
    .filter(year => year < period.value).map(year => new Option(year, year)));
  if ([...baseline.options].some(option => option.value === previous)) baseline.value = previous;
  const previousFocus = focus.value;
  const ids = selected();
  focus.replaceChildren(new Option('Без опорного субъекта', ''), ...catalog.subjects
    .filter(subject => ids.includes(subject.subject_id))
    .map(subject => new Option(subject.name, subject.subject_id)));
  if (ids.includes(previousFocus)) focus.value = previousFocus;
}

function valueText(value, signed = false) {
  if (value === null) return '—';
  const text = String(value);
  if (text.startsWith('-')) return '−' + text.slice(1).replace('.', ',');
  const greaterThanZero = /[1-9]/.test(text);
  return (signed && greaterThanZero ? '+' : '') + text.replace('.', ',');
}

function table(title, labels, rows, name) {
  const section = element('section');
  const heading = element('h2', title);
  heading.id = name;
  const area = element('div', undefined, 'table-area');
  area.tabIndex = 0;
  area.setAttribute('role', 'region');
  area.setAttribute('aria-labelledby', name);
  const node = element('table');
  node.setAttribute('aria-labelledby', name);
  const head = node.createTHead().insertRow();
  for (const label of labels) {
    const cell = element('th', label);
    cell.scope = 'col';
    head.append(cell);
  }
  const body = node.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    const subject = element('th', row.name);
    subject.scope = 'row';
    subject.append(element('span', row.subject_id, 'subject-id'));
    tr.append(subject);
    for (const [value, signed] of row.fields) {
      const td = tr.insertCell();
      const text = valueText(value, signed);
      if (signed && value !== null) {
        const tone = text.startsWith('+') ? 'up' : text.startsWith('−') ? 'down' : 'neutral';
        td.append(element('span', text, `delta ${tone}`));
      } else td.textContent = text;
    }
  }
  area.append(node);
  section.append(heading, area);
  return section;
}

function sourceLink(label, reference) {
  if (/^https?:\/\//i.test(reference)) {
    const link = element('a', label);
    link.href = reference;
    return link;
  }
  return element('span', `${label} · ${reference}`);
}

function render(result) {
  const {current, baseline: base} = result;
  const context = element('p', `Период ${current.period} · ${current.population_size} в рейтинге · Выбрано ${result.rows.length}`
    + (base ? ` · База ${base.period} (${base.population_size} в рейтинге)` : ''), 'context');
  const summary = element('section', undefined, 'summary');
  summary.append(element('h2', 'Краткий итог'), ...result.summary.map(line => element('p', line)));
  const mode = result.brief_mode === 'ai_assisted' ? 'Итог составлен с помощью ИИ по рассчитанным фактам.' : 'Итог составлен по шаблону.';
  summary.append(element('p', mode, 'note'));
  const labels = ['Субъект', `Место ${current.period}`, `Балл ${current.period}`];
  if (base) labels.push(`Место ${base.period}`, `Балл ${base.period}`, 'Δ места', 'Δ балла');
  const comparison = table('Таблица сравнения', labels, result.rows.map(row => ({...row, fields: [
    [row.rank, false], [row.score, false], ...(base ? [
      [row.baseline_rank, false], [row.baseline_score, false], [row.rank_delta, true], [row.score_delta, true],
    ] : []),
  ]})), 'comparison-table');
  if (base) comparison.append(element('p', 'Плюс в столбце изменения места означает улучшение позиции.', 'note'));
  output.replaceChildren(context, summary, comparison);
  if (result.gaps.length) {
    const name = result.rows.find(row => row.subject_id === result.focus_subject_id).name;
    const gapLabels = ['Субъект сравнения', `Разрыв ${current.period}`];
    if (base) gapLabels.push(`Разрыв ${base.period}`, 'Δ разрыва');
    const gaps = table('Разрывы по баллам', gapLabels, result.gaps.map(row => ({...row, fields: [
      [row.current, true], ...(base ? [[row.baseline, true], [row.delta, true]] : []),
    ]})), 'gap-table');
    gaps.append(element('p', `Опорный субъект — ${name}. Плюс означает преимущество, минус — отставание.`, 'note'));
    output.append(gaps);
  }
  if (result.partial) {
    const limits = element('section', undefined, 'limits');
    const list = element('ul');
    list.append(...result.limits.map(limit => element('li', limit)));
    limits.append(element('h2', 'Ограничения сравнения'), list);
    output.append(limits);
  }
  const sources = element('section');
  const list = element('ul');
  for (const snapshot of [current, base].filter(Boolean)) {
    const source = snapshot.source;
    const item = element('li');
    item.append(`${snapshot.period} год · `, sourceLink(source.title, source.reference),
      ` · Опубликовано ${source.published_on.split('-').reverse().join('.')} · Методика ${snapshot.methodology_version}`);
    if (source.data_reference) item.append(' · ', sourceLink('Таблица рейтинга', source.data_reference));
    list.append(item);
  }
  sources.append(element('h2', 'Источники'), list);
  output.append(sources);
  output.hidden = false;
}

async function runComparison(ai = false) {
  const ids = selected();
  if (ids.length < 2) {
    message('Выберите не менее двух субъектов.', true);
    return;
  }
  const body = {period: period.value, subject_ids: ids};
  if (baseline.value) body.baseline = baseline.value;
  if (focus.value) body.focus_subject_id = focus.value;
  const query = new URLSearchParams({period: body.period});
  ids.forEach(id => query.append('subject', id));
  if (body.baseline) query.set('baseline', body.baseline);
  if (body.focus_subject_id) query.set('focus_subject', body.focus_subject_id);
  settings.disabled = true;
  output.hidden = true;
  message(ai ? 'Подготавливаем справку…' : 'Загружаем сравнение…');
  try {
    const result = ai ? await request('/api/v1/briefs', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    }) : await request(`/api/v1/comparisons?${query}`);
    render(result);
    message(ai && result.brief_mode === 'template' ? 'ИИ недоступен. Показана справка по шаблону.' : '');
  } catch (error) {
    message(error.message, true);
  } finally {
    settings.disabled = false;
  }
}

async function load() {
  retry.hidden = true;
  message('Загружаем справочник…');
  try {
    catalog = await request('/api/v1/rating');
    document.querySelector('#rating-title').textContent = catalog.rating_title;
    document.querySelector('#demo-label').hidden = catalog.data_kind !== 'demo';
    period.replaceChildren(...catalog.periods.map(year => new Option(year, year)));
    const suggested = catalog.rating_id === 'ria-social-economic-regions' ? ['yanao', 'khmao-yugra'] : ['demo-a', 'demo-b', 'demo-c'];
    subjects.replaceChildren(...catalog.subjects.map(subject => {
      const label = element('label');
      const input = element('input');
      input.type = 'checkbox';
      input.value = subject.subject_id;
      input.checked = suggested.includes(subject.subject_id);
      label.append(input, subject.name);
      return label;
    }));
    updateOptions();
    if (selected().includes('yanao')) focus.value = 'yanao';
    settings.disabled = false;
    message('');
    if (period.value && selected().length >= 2) await runComparison();
  } catch (error) {
    message(error.message, true);
    retry.hidden = false;
  }
}

period.addEventListener('change', updateOptions);
subjects.addEventListener('change', updateOptions);
retry.addEventListener('click', load);
form.addEventListener('submit', event => {
  event.preventDefault();
  runComparison(event.submitter?.value === 'ai');
});
load();
