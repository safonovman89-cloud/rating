const stateLabel = document.querySelector('#admin-state');
const checked = document.querySelector('#admin-checked');
const next = document.querySelector('#admin-next');
const detail = document.querySelector('#admin-detail');
const button = document.querySelector('#admin-refresh');
const feedback = document.querySelector('#admin-feedback');
const date = new Intl.DateTimeFormat('ru-RU', {dateStyle: 'short', timeStyle: 'short'});
const number = new Intl.NumberFormat('ru-RU');
const seconds = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2});
const labels = {
  waiting: 'Ожидает проверки', updated: 'Данные обновлены',
  unchanged: 'Изменений нет', error: 'Проверка завершилась ошибкой',
};
const triggers = {scheduled: 'Автоматически', manual: 'Из панели', cli: 'Из CLI'};
let lastCheck;

function valueCell(value) {
  const cell = document.createElement('td');
  cell.textContent = value;
  return cell;
}

function coverageRow(snapshot) {
  const row = document.createElement('tr');
  const complete = valueCell(`${snapshot.complete} из ${snapshot.population_size}`);
  const progress = document.createElement('progress');
  progress.max = snapshot.population_size;
  progress.value = snapshot.complete;
  progress.setAttribute('aria-label', `Покрытие выпуска за ${snapshot.period} год`);
  complete.append(progress);
  row.append(valueCell(snapshot.period), valueCell(snapshot.published_on.split('-').reverse().join('.')),
    valueCell(`${snapshot.loaded} из ${snapshot.population_size}`), complete,
    valueCell(snapshot.missing_rank), valueCell(snapshot.missing_score));
  return row;
}

function historyRow(run) {
  const row = document.createElement('tr');
  const outcome = valueCell(labels[run.outcome]);
  if (run.error_message) {
    const reason = document.createElement('small');
    reason.className = 'note';
    reason.textContent = run.error_message;
    outcome.append(reason);
  }
  row.append(valueCell(date.format(new Date(run.checked_at))), valueCell(triggers[run.trigger]), outcome,
    valueCell(run.duration_ms < 1000 ? `${number.format(run.duration_ms)} мс` : `${seconds.format(run.duration_ms / 1000)} с`));
  return row;
}

async function loadAnalytics() {
  const notice = document.querySelector('#admin-analytics-status');
  try {
    const data = await request('/admin/api/v1/analytics');
    document.querySelector('#admin-region-count').textContent = number.format(data.subject_count);
    document.querySelector('#admin-snapshot-count').textContent = number.format(data.snapshot_count);
    document.querySelector('#admin-observation-count').textContent = number.format(data.observation_count);
    document.querySelector('#admin-coverage-table tbody').replaceChildren(...data.snapshots.map(coverageRow));
    document.querySelector('#admin-coverage-table').hidden = !data.snapshots.length;
    document.querySelector('#admin-no-snapshots').hidden = Boolean(data.snapshots.length);
    const totals = data.refresh_summary;
    document.querySelector('#admin-history-summary').textContent = `За 30 суток · Проверки ${number.format(totals.total)} · ` +
      `Загрузки ${number.format(totals.updated)} · Без изменений ${number.format(totals.unchanged)} · Ошибки ${number.format(totals.errors)}`;
    document.querySelector('#admin-history-table tbody').replaceChildren(...data.recent_runs.map(historyRow));
    document.querySelector('#admin-history-table').hidden = !data.recent_runs.length;
    document.querySelector('#admin-no-runs').hidden = Boolean(data.recent_runs.length);
    document.querySelector('#admin-analytics-content').hidden = false;
    notice.hidden = true;
  } catch (error) {
    notice.textContent = `Не удалось загрузить аналитику. ${error.message}`;
    notice.hidden = false;
  }
}

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? 'Запрос не выполнен.');
  return body;
}

async function status() {
  try {
    const data = await request('/api/v1/refresh');
    stateLabel.textContent = !data.enabled ? 'Обновление выключено' : data.running ? 'Идёт проверка' : labels[data.state];
    checked.textContent = data.checked_at ? date.format(new Date(data.checked_at)) : '—';
    next.textContent = data.next_check_at && !data.running ? date.format(new Date(data.next_check_at)) : '—';
    detail.hidden = !data.error || data.running;
    detail.textContent = data.error ?? '';
    button.disabled = !data.enabled || data.running;
    const previous = lastCheck;
    lastCheck = data.checked_at ?? null;
    if (previous !== lastCheck) loadAnalytics();
    if (data.running) window.setTimeout(status, 1000);
  } catch {
    stateLabel.textContent = 'Не удалось загрузить состояние проверки';
    if (lastCheck === undefined) loadAnalytics();
  }
}

button.addEventListener('click', async () => {
  button.disabled = true;
  feedback.textContent = '';
  try {
    await request('/admin/api/v1/refresh', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}',
    });
    feedback.textContent = 'Проверка запрошена.';
  } catch (error) {
    feedback.textContent = error.message;
  }
  status();
});

status();
