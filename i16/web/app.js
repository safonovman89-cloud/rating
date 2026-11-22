import { createRegionMap } from './russia-map.js';

const form = document.querySelector('#comparison-form');
const settings = document.querySelector('#settings');
const period = document.querySelector('#period');
const baseline = document.querySelector('#baseline');
const focus = document.querySelector('#focus');
const subjects = document.querySelector('#subjects');
const subjectSearch = document.querySelector('#subject-search');
const subjectCount = document.querySelector('#subject-count');
const subjectsEmpty = document.querySelector('#subjects-empty');
const status = document.querySelector('#status');
const output = document.querySelector('#report');
const retry = document.querySelector('#retry');
const staleReport = document.querySelector('#stale-report');
const presets = document.querySelector('#presets');
const executive = document.querySelector('#executive');
const executiveStale = document.querySelector('#executive-stale');
const executiveDetails = document.querySelector('#executive-details');
const printButton = document.querySelector('#executive-print-button');
const printView = document.querySelector('#executive-print');
const riaId = 'ria-social-economic-regions';
const checks = [
  ['Занятость и безработица', 'https://rosstat.gov.ru/labour_force'],
  ['Реальные денежные доходы', 'https://rosstat.gov.ru/folder/13397'],
  ['Инвестиции в основной капитал', 'https://rosstat.gov.ru/investment_nonfinancial'],
];
let catalog;
let displayedParameters;
let executiveReport;
let refreshTimer;
const regionMap = createRegionMap({request, element, sourceLink, valueText, addSubject});

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

function comparisonParameters() {
  const body = {period: period.value, subject_ids: selected()};
  if (baseline.value) body.baseline = baseline.value;
  if (focus.value) body.focus_subject_id = focus.value;
  return body;
}

function normalizedSearch(value) {
  return value.toLowerCase().replaceAll('ё', 'е').trim();
}

function filterSubjects() {
  const query = normalizedSearch(subjectSearch.value);
  let matches = 0;
  for (const label of subjects.children) {
    label.hidden = !normalizedSearch(label.textContent).includes(query);
    if (!label.hidden) matches++;
  }
  subjectsEmpty.hidden = matches > 0;
  subjects.scrollTop = 0;
}

function updateReportNotice() {
  const stale = displayedParameters !== undefined && JSON.stringify(comparisonParameters()) !== displayedParameters;
  staleReport.hidden = output.hidden || !stale;
  executiveStale.hidden = !stale;
  executiveDetails.hidden = output.hidden;
  printButton.disabled = output.hidden || stale;
  regionMap.setStale(output.hidden || stale);
}

function updateOptions() {
  const previous = baseline.value;
  baseline.replaceChildren(new Option('Без базы', ''), ...catalog.periods
    .filter(year => year < period.value).map(year => new Option(year, year)));
  if ([...baseline.options].some(option => option.value === previous)) baseline.value = previous;
  const previousFocus = focus.value;
  const ids = selected();
  subjectCount.textContent = `Выбрано ${ids.length}`;
  focus.replaceChildren(new Option('Без опорного субъекта', ''), ...catalog.subjects
    .filter(subject => ids.includes(subject.subject_id))
    .map(subject => new Option(subject.name, subject.subject_id)));
  if (ids.includes(previousFocus)) focus.value = previousFocus;
}

function renderPresets() {
  if (catalog.rating_id !== riaId) return;
  const available = new Set(catalog.subjects.map(subject => subject.subject_id));
  const groups = [
    ['ЯНАО и Югра', ['khmao-yugra']],
    ['ЯНАО и УрФО', ['khmao-yugra', 'tyumen-oblast', 'sverdlovsk-oblast', 'chelyabinsk-oblast', 'kurgan-oblast']],
    ['ЯНАО и лидеры рейтинга', catalog.leaders?.[period.value] ?? []],
  ];
  const buttons = [];
  for (const [label, peers] of groups) {
    const group = new Set(['yanao', ...peers].filter(id => available.has(id)));
    if (!group.has('yanao') || group.size < 2) continue;
    const button = element('button', label, 'secondary');
    button.type = 'button';
    button.addEventListener('click', () => {
      for (const input of subjects.querySelectorAll('input')) input.checked = group.has(input.value);
      subjectSearch.value = '';
      filterSubjects();
      updateOptions();
      focus.value = 'yanao';
      runComparison();
    });
    buttons.push(button);
  }
  presets.replaceChildren(...buttons);
  presets.hidden = buttons.length === 0;
}

function addSubject(identifier) {
  for (const input of subjects.querySelectorAll('input')) {
    if (input.value === identifier) input.checked = true;
  }
  updateOptions();
  runComparison();
}

async function updateRefreshStatus() {
  const info = document.querySelector('#ria-refresh-status');
  try {
    const state = await request('/api/v1/refresh');
    if (!state.enabled) return;
    const format = new Intl.DateTimeFormat('ru-RU', {dateStyle: 'short', timeStyle: 'short'});
    const checked = state.checked_at ? format.format(new Date(state.checked_at)) : '';
    const next = format.format(new Date(state.next_check_at));
    const summary = {
      waiting: 'Проверяем источник РИА…',
      updated: `Данные РИА обновлены ${checked}`,
      unchanged: `Источник РИА проверен ${checked}`,
      error: `Проверка не удалась ${checked}. Используются сохранённые данные`,
    }[state.state];
    info.textContent = state.state === 'waiting' ? summary : `${summary} · следующая проверка ${next}`;
    info.title = state.error ?? '';
    info.hidden = false;
    refreshTimer ??= window.setInterval(updateRefreshStatus, 60000);
  } catch {
    info.hidden = true;
  }
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

function reportSources(result) {
  const section = element('section');
  const list = element('ul');
  for (const snapshot of [result.current, result.baseline].filter(Boolean)) {
    const source = snapshot.source;
    const item = element('li');
    item.append(`${snapshot.period} год · `, sourceLink(source.title, source.reference),
      ` · Опубликовано ${source.published_on.split('-').reverse().join('.')} · Методика ${snapshot.methodology_version}`);
    if (source.data_reference) item.append(' · ', sourceLink('Таблица рейтинга', source.data_reference));
    list.append(item);
  }
  section.append(element('h2', 'Источники'), list);
  return section;
}

function chart(title, rows, key, unit, {signed = false, note = ''} = {}) {
  const panel = element('figure', undefined, 'chart');
  panel.append(element('figcaption', title));
  const values = rows.map(row => row[key] === null ? null : Number(row[key]));
  const known = values.filter(Number.isFinite);
  if (!known.length) {
    panel.append(element('p', signed ? 'Сопоставимых значений для графика нет.' : 'Доступных значений для графика нет.', 'note'));
    if (note) panel.append(element('p', note, 'note'));
    return panel;
  }

  const magnitude = Math.max(1, ...known.map(Math.abs));
  const power = 10 ** Math.floor(Math.log10(magnitude));
  const limit = Math.ceil(magnitude / power) * power;
  const minimum = signed || known.some(value => value < 0) ? -limit : 0;
  const position = value => (value - minimum) / (limit - minimum) * 100;
  const zero = position(0);
  const axis = element('div', undefined, 'plot-axis');
  const ticks = element('div', undefined, 'plot-ticks');
  ticks.setAttribute('aria-hidden', 'true');
  ticks.append(element('span', valueText(minimum)), ...(minimum < 0 ? [element('span', '0')] : []), element('span', valueText(limit, signed)));
  axis.append(ticks, element('span', unit));
  panel.append(axis);

  const list = element('ul', undefined, 'plot-rows');
  for (const [index, row] of rows.entries()) {
    const value = values[index];
    const line = element('li', undefined, 'plot-row');
    const track = element('span', undefined, 'plot-track');
    track.style.setProperty('--axis-zero', `${zero}%`);
    track.setAttribute('aria-hidden', 'true');
    if (Number.isFinite(value)) {
      const tone = !signed ? 'score' : value < 0 ? 'negative' : value > 0 ? 'positive' : 'at-zero';
      const bar = element('span', undefined, `plot-bar ${tone}`);
      const edge = position(value);
      bar.style.setProperty('--start', `${Math.min(zero, edge)}%`);
      bar.style.setProperty('--length', `${Math.abs(edge - zero)}%`);
      track.append(bar);
    }
    const label = Number.isFinite(value) ? valueText(row[key], signed) : '—';
    line.append(element('span', row.name, 'plot-name'), track, element('span', label, 'plot-value'));
    list.append(line);
  }
  panel.append(list);
  if (note || known.length < rows.length) {
    const coverage = known.length < rows.length ? ` Доступно ${known.length} из ${rows.length} значений.` : '';
    panel.append(element('p', (note + coverage).trim(), 'note'));
  }
  return panel;
}

function dashboard(result) {
  const {current, baseline: base, rows} = result;
  const section = element('section', undefined, 'dashboard');
  section.append(element('h2', 'Аналитический дашборд'));
  const grid = element('div', undefined, 'chart-grid');
  grid.append(chart(`Баллы за ${current.period} год`, rows, 'score', 'баллы'));
  if (base) {
    grid.append(
      chart(`Изменение балла · ${base.period} → ${current.period}`, rows, 'score_delta', 'баллы', {signed: true}),
      chart(`Изменение места · ${base.period} → ${current.period}`, rows, 'rank_delta', 'места', {
        signed: true, note: 'Плюс означает улучшение места.',
      }),
    );
  }
  if (result.gaps.length) {
    const focusName = rows.find(row => row.subject_id === result.focus_subject_id).name;
    grid.append(chart(`Разрывы по баллам за ${current.period} год`, result.gaps, 'current', 'баллы', {
      signed: true, note: `Опорный субъект — ${focusName}. Плюс означает преимущество, минус — отставание.`,
    }));
  }
  section.append(grid);
  return section;
}

function comparisonTable(result, rows, id) {
  const labels = ['Субъект', `Место ${result.current.period}`, `Балл ${result.current.period}`];
  const base = result.baseline;
  if (base) labels.push(`Место ${base.period}`, `Балл ${base.period}`, 'Δ места', 'Δ балла');
  return table('Таблица сравнения', labels, rows.map(row => ({...row, fields: [
    [row.rank, false], [row.score, false], ...(base ? [
      [row.baseline_rank, false], [row.baseline_score, false], [row.rank_delta, true], [row.score_delta, true],
    ] : []),
  ]})), id);
}

function executiveSelection(result) {
  const subject = result.rows.find(row => row.subject_id === result.focus_subject_id) ?? result.rows[0];
  const yugra = subject.subject_id === 'yanao' && result.gaps.find(row => row.subject_id === 'khmao-yugra');
  return {subject, gap: yugra || result.gaps[0], title: subject.subject_id === 'yanao' ? 'ЯНАО за минуту' : subject.name};
}

function gapMagnitude(value) {
  return valueText(value === null ? null : value.replace(/^-/, ''));
}

function gapDirection(value) {
  if (value === null) return 'Нет данных';
  if (Number(value) === 0) return 'Равный балл';
  return Number(value) < 0 ? 'Отставание' : 'Преимущество';
}

function executiveMetrics(result, subject, gap) {
  const base = result.baseline;
  const rank = subject.rank === null ? '—' : `${subject.rank}-е из ${result.current.population_size}`;
  const rankChange = base ? `${base.period} · ${valueText(subject.baseline_rank)} · Δ ${valueText(subject.rank_delta, true)}` : '';
  const scoreChange = base ? `${base.period} · ${valueText(subject.baseline_score)} · Δ ${valueText(subject.score_delta, true)}` : '';
  const metrics = [
    ['Место в рейтинге', rank, rankChange],
    ['Балл', valueText(subject.score), scoreChange],
  ];
  if (gap) {
    const label = gap.subject_id === 'khmao-yugra' ? 'Разрыв с Югрой, баллы' : `Разрыв · ${gap.name}, баллы`;
    const direction = gapDirection(gap.current);
    const change = Number(gap.delta);
    const directionUnchanged = direction === gapDirection(gap.baseline) && gap.current !== null;
    const widened = Number(gap.current) < 0 ? change < 0 : change > 0;
    const trend = directionUnchanged && change !== 0
      ? `${direction} ${widened ? 'выросло' : 'сократилось'} на ${gapMagnitude(gap.delta)}` : direction;
    const previous = base ? ` · в ${base.period} году ${gapMagnitude(gap.baseline)}` : '';
    metrics.push([label, gapMagnitude(gap.current), trend + previous]);
  }
  return metrics.map(([label, value, detail]) => {
    const card = element('div', undefined, 'executive-metric');
    card.append(element('p', label, 'metric-label'), element('strong', value), element('p', detail, 'note'));
    return card;
  });
}

function renderExecutive(result) {
  if (catalog.rating_id !== riaId) return;
  executiveReport = result;
  const {subject, gap, title} = executiveSelection(result);
  executive.querySelector('#executive-title').textContent = title;
  const source = result.current.source;
  const context = result.baseline ? `${result.current.period} год · база ${result.baseline.period} · ` : `${result.current.period} год · `;
  executive.querySelector('#executive-source').replaceChildren(context, sourceLink(source.title, source.reference));
  executive.querySelector('#executive-metrics').replaceChildren(...executiveMetrics(result, subject, gap));
  const followUp = executive.querySelector('#executive-checks');
  followUp.replaceChildren();
  if (result.focus_subject_id && (subject.rank_delta < 0 || Number(subject.score_delta) < 0)) {
    const box = element('details', undefined, 'executive-checks');
    const sources = element('ul');
    for (const [label, url] of checks) {
      const item = element('li');
      item.append(sourceLink(label, url), ` · Росстат · ${result.current.period} год`);
      sources.append(item);
    }
    box.append(element('summary', 'Что проверить'),
      element('p', 'Эти ряды дают контекст. Для вывода о причинах изменения балла нужны данные РИА по компонентам рейтинга.', 'note'), sources);
    followUp.append(box);
  }
  executive.hidden = false;
}

function printExecutive() {
  if (printButton.disabled || !executiveReport) return;
  const result = executiveReport;
  const {subject, gap, title} = executiveSelection(result);
  const essential = new Set([subject.subject_id]);
  if (gap) essential.add(gap.subject_id);
  const peers = result.rows.filter(row => !essential.has(row.subject_id)).slice(0, 5 - essential.size);
  for (const peer of peers) essential.add(peer.subject_id);
  const rows = result.rows.filter(row => essential.has(row.subject_id));
  const metrics = element('div', undefined, 'executive-metrics');
  metrics.append(...executiveMetrics(result, subject, gap));
  const periodText = result.baseline ? `${result.current.period} год · база ${result.baseline.period}` : `${result.current.period} год`;
  printView.replaceChildren(element('p', 'И16 · Справка для руководителя', 'note'), element('h1', title),
    element('p', `${result.rating_title} · ${periodText}`), metrics, comparisonTable(result, rows, 'print-comparison-table'));
  if (rows.length < result.rows.length) {
    printView.append(element('p', `Показано ${rows.length} из ${result.rows.length} выбранных субъектов.`, 'note'));
  }
  if (gap) {
    const trend = [{name: result.current.period, gap: gap.current}];
    if (result.baseline) trend.unshift({name: result.baseline.period, gap: gap.baseline});
    printView.append(chart(`Разрыв · ${gap.name}`, trend, 'gap', 'баллы', {
      signed: true, note: 'Минус означает отставание опорного региона.',
    }));
  }
  if (result.partial) printView.append(element('p', 'Справка частичная. Причины указаны в полном сравнении.', 'note'));
  printView.append(reportSources(result));
  document.body.classList.add('print-executive');
  window.print();
}

function render(result) {
  const {current, baseline: base} = result;
  const context = element('p', `Период ${current.period} · ${current.population_size} в рейтинге · Выбрано ${result.rows.length}`
    + (base ? ` · База ${base.period} (${base.population_size} в рейтинге)` : ''), 'context');
  const summary = element('section', undefined, 'summary');
  summary.append(element('h2', 'Краткий итог'), ...result.summary.map(line => element('p', line)));
  const mode = result.brief_mode === 'ai_assisted' ? 'Итог составлен с помощью ИИ по рассчитанным фактам.' : 'Итог составлен по шаблону.';
  summary.append(element('p', mode, 'note'));
  const comparison = comparisonTable(result, result.rows, 'comparison-table');
  if (base) comparison.append(element('p', 'Плюс в столбце изменения места означает улучшение позиции.', 'note'));
  output.replaceChildren(context, summary, dashboard(result), comparison);
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
  output.append(reportSources(result));
  renderExecutive(result);
  if (catalog.rating_id === riaId) regionMap.update(result);
  output.hidden = false;
}

async function runComparison(ai = false) {
  const body = comparisonParameters();
  if (body.subject_ids.length < 2) {
    message('Выберите не менее двух субъектов.', true);
    return;
  }
  const query = new URLSearchParams({period: body.period});
  body.subject_ids.forEach(id => query.append('subject', id));
  if (body.baseline) query.set('baseline', body.baseline);
  if (body.focus_subject_id) query.set('focus_subject', body.focus_subject_id);
  settings.disabled = true;
  output.hidden = true;
  updateReportNotice();
  message(ai ? 'Подготавливаем справку…' : 'Загружаем сравнение…');
  try {
    const result = ai ? await request('/api/v1/briefs', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    }) : await request(`/api/v1/comparisons?${query}`);
    render(result);
    displayedParameters = JSON.stringify(body);
    updateReportNotice();
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
    catalog.subjects.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    document.querySelector('#rating-title').textContent = catalog.rating_title;
    document.querySelector('#demo-label').hidden = catalog.data_kind !== 'demo';
    period.replaceChildren(...catalog.periods.map(year => new Option(year, year)));
    const isRia = catalog.rating_id === riaId;
    if (isRia) updateRefreshStatus();
    document.body.classList.toggle('has-executive', isRia);
    const suggested = isRia ? ['yanao', 'khmao-yugra'] : ['demo-a', 'demo-b', 'demo-c'];
    subjects.replaceChildren(...catalog.subjects.map(subject => {
      const label = element('label');
      const input = element('input');
      input.type = 'checkbox';
      input.value = subject.subject_id;
      input.checked = suggested.includes(subject.subject_id);
      label.append(input, subject.name);
      return label;
    }));
    filterSubjects();
    updateOptions();
    if (isRia && catalog.default_baseline) baseline.value = catalog.default_baseline;
    if (selected().includes('yanao')) focus.value = 'yanao';
    renderPresets();
    settings.disabled = false;
    message('');
    if (period.value && selected().length >= 2) await runComparison();
  } catch (error) {
    message(error.message, true);
    retry.hidden = false;
  }
}

form.addEventListener('change', event => {
  if (event.target === subjectSearch) return;
  if (event.target === period || subjects.contains(event.target)) updateOptions();
  if (event.target === period) renderPresets();
  updateReportNotice();
});
subjectSearch.addEventListener('input', filterSubjects);
printButton.addEventListener('click', printExecutive);
window.addEventListener('afterprint', () => document.body.classList.remove('print-executive'));
retry.addEventListener('click', load);
form.addEventListener('submit', event => {
  event.preventDefault();
  runComparison(event.submitter?.value === 'ai');
});
load();
