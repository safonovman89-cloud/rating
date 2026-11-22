import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [, , serverUrls, outputDir, riaPath] = process.argv;
const urls = JSON.parse(serverUrls);
const riaDataset = JSON.parse(await readFile(riaPath, 'utf8'));
const browser = await chromium.launch({
  executablePath: process.env.I16_E2E_BROWSER,
  headless: true,
});
console.log(`Chromium ${browser.version()}`);
const cases = [];
const test = (name, run) => cases.push({name, run});
const demoQuery = '/api/v1/comparisons?period=2025&baseline=2024&subject=demo-a&subject=demo-b&subject=demo-c';
const riaQuery = '/api/v1/comparisons?period=2025&baseline=2024&subject=yanao&subject=khmao-yugra';
const compare = page => page.getByRole('button', {name: 'Сравнить', exact: true});
const ai = page => page.getByRole('button', {name: 'Справка с ИИ', exact: true});
const adminCredentials = {username: 'test-admin', password: 'test-admin-password'};
const adminHeader = `Basic ${Buffer.from(`${adminCredentials.username}:${adminCredentials.password}`).toString('base64')}`;

async function ready(page, url) {
  await page.goto(url);
  await page.locator('#report').waitFor({state: 'visible'});
}

async function submit(page, button = compare(page), endpoint = '/api/v1/comparisons') {
  const [response] = await Promise.all([
    page.waitForResponse(item => item.url().includes(endpoint)),
    button.click(),
  ]);
  assert.equal(response.status(), 200);
  await page.locator('#report').waitFor({state: 'visible'});
  return response.json();
}

async function cells(page, table, id) {
  return page.getByRole('table', {name: table, exact: true}).locator('tbody tr')
    .filter({has: page.getByText(id, {exact: true})}).locator('td').allTextContents();
}

async function chart(page, title) {
  const figure = page.locator('figure').filter({has: page.locator('figcaption', {hasText: title})});
  return figure.locator('.plot-value').allTextContents();
}

test('A13 · справочник, порядок строк, дельты и источники API', async page => {
  const response = await page.request.get(urls.demo + '/api/v1/rating');
  assert.equal(response.status(), 200);
  const rating = await response.json();
  assert.deepEqual(rating.periods, ['2025', '2024']);
  assert.deepEqual(rating.subjects.map(item => item.subject_id), ['demo-a', 'demo-b', 'demo-c', 'demo-d']);
  const report = await page.request.get(urls.demo + demoQuery);
  assert.equal(report.status(), 200);
  const body = await report.json();
  assert.deepEqual(body.rows.map(row => [row.subject_id, row.rank, row.score, row.rank_delta, row.score_delta]), [
    ['demo-a', 2, '82.50', 2, '6.50'], ['demo-b', 2, '82.50', 0, '-1.50'], ['demo-c', 4, '78.00', -1, '1.00'],
  ]);
  assert.equal(body.current.source.published_on, '2026-01-15');
  assert.equal(body.baseline.source.published_on, '2025-01-15');
});

test('A14 · ошибки API 400 и 503', async page => {
  const bad = await page.request.get(urls.demo + '/api/v1/comparisons?period=2025&subject=demo-a');
  assert.equal(bad.status(), 400);
  assert.match((await bad.json()).error.message, /двух/);
  const offline = await page.request.get(urls.databaseOffline + demoQuery);
  assert.equal(offline.status(), 503);
  assert.equal((await offline.json()).error.code, 'database_unavailable');
});

test('A15/V01–V04 · демосправка, ширина 1280/375, прокрутка и печать A4', async page => {
  await ready(page, urls.demo);
  assert.ok(await page.locator('#demo-label').isVisible());
  assert.equal(await page.locator('.hero').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(191, 18, 56)');
  assert.deepEqual(await cells(page, 'Таблица сравнения', 'demo-a'), ['2', '82,50']);
  assert.equal(await page.locator('.chart').count(), 1);
  await page.locator('#baseline').selectOption('2024');
  await submit(page);
  assert.deepEqual(await cells(page, 'Таблица сравнения', 'demo-a'), ['2', '82,50', '4', '76,00', '+2', '+6,50']);
  assert.deepEqual(await cells(page, 'Таблица сравнения', 'demo-b'), ['2', '82,50', '2', '84,00', '0', '−1,50']);
  assert.deepEqual(await cells(page, 'Таблица сравнения', 'demo-c'), ['4', '78,00', '3', '77,00', '−1', '+1,00']);
  assert.match(await page.locator('.summary').innerText(), /4,50/);
  assert.match(await page.locator('#report').innerText(), /Опубликовано 15\.01\.2026/);
  const table = page.getByRole('region', {name: 'Таблица сравнения'});
  assert.ok(await table.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await page.setViewportSize({width: 375, height: 812});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
  assert.ok(await table.evaluate(el => el.scrollWidth > el.clientWidth));
  assert.ok(await table.evaluate(el => {
    el.scrollLeft = el.scrollWidth;
    const last = el.querySelector('thead th:last-child');
    return el.scrollLeft > 0 && last.getBoundingClientRect().right <= el.getBoundingClientRect().right;
  }));
  await page.setViewportSize({width: 1280, height: 900});
  await page.emulateMedia({media: 'print'});
  assert.equal(await page.locator('#comparison-form').isVisible(), false);
  assert.equal(await page.locator('[data-help-page]').isVisible(), false);
  assert.equal(await page.locator('.hero').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  assert.ok(await page.getByRole('columnheader', {name: 'Δ балла'}).isVisible());
  const pdf = await page.pdf({format: 'A4', printBackground: false});
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  await page.emulateMedia({media: 'screen'});
  await page.locator('#baseline').selectOption('');
  await submit(page);
  assert.deepEqual(await cells(page, 'Таблица сравнения', 'demo-b'), ['2', '82,50']);
});

test('A16 · частичная справка и повтор после сетевой ошибки', async page => {
  await ready(page, urls.partial);
  await page.locator('#baseline').selectOption('2024');
  let result = await submit(page);
  assert.equal(result.partial, true);
  assert.match(await page.locator('.limits').innerText(), /охват|состав/i);
  assert.deepEqual(await cells(page, 'Таблица сравнения', 'demo-a'), ['2', '82,50', '4', '76,00', '—', '+6,50']);
  await page.route('**/api/v1/comparisons?*', route => route.abort('connectionfailed'), {times: 1});
  await compare(page).click();
  await page.getByText('Сервер недоступен. Повторите запрос.', {exact: true}).waitFor();
  assert.ok(await compare(page).isEnabled());
  result = await submit(page);
  assert.equal(result.partial, true);
  await page.goto(urls.databaseOffline);
  await page.getByText('PostgreSQL недоступен.', {exact: false}).waitFor();
  assert.ok(await page.getByRole('button', {name: 'Загрузить справочник'}).isVisible());
});

test('A17/A18/A22/A23 · пилот РИА, графики, источники и фильтры', async page => {
  await ready(page, urls.ria);
  assert.equal(await page.locator('#subjects input').count(), riaDataset.subjects.length);
  await page.locator('#baseline').selectOption('');
  await submit(page);
  assert.deepEqual(await chart(page, /Баллы за 2025/), ['76,80', '68,78']);
  assert.equal(await page.locator('figcaption').filter({hasText: 'Изменение балла'}).count(), 0);
  await page.locator('#baseline').selectOption('2024');
  await page.locator('#focus').selectOption('yanao');
  await submit(page);
  assert.match(await page.locator('.context').innerText(), /Период 2025 · 85 в рейтинге · Выбрано 2 · База 2024 \(85 в рейтинге\)/);
  assert.deepEqual(await cells(page, 'Таблица сравнения', 'yanao'), ['10', '68,78', '9', '73,14', '−1', '−4,36']);
  assert.deepEqual(await chart(page, /Изменение балла/), ['−3,27', '−4,36']);
  assert.deepEqual(await chart(page, /Изменение места/), ['−1', '−1']);
  assert.deepEqual(await cells(page, 'Разрывы по баллам', 'khmao-yugra'), ['−8,02', '−6,93', '−1,09']);
  assert.deepEqual(await page.locator('#report a').evaluateAll(items => items.map(item => item.getAttribute('href'))),
    riaDataset.snapshots.flatMap(({source}) => [source.reference, source.data_reference]));
  assert.match(await page.locator('#report').innerText(), /2025 год[^\n]*15\.06\.2026/);
  assert.match(await page.locator('#report').innerText(), /2024 год[^\n]*23\.06\.2025/);
  await page.locator('input[value="tyumen-oblast"]').check();
  await submit(page);
  assert.deepEqual(await cells(page, 'Разрывы по баллам', 'tyumen-oblast'), ['+6,54', '+5,32', '+1,22']);
  await page.locator('input[value="kurgan-oblast"]').check();
  await page.locator('input[value="moscow"]').check();
  let result = await submit(page);
  assert.equal((await cells(page, 'Таблица сравнения', 'kurgan-oblast'))[0], '63');
  assert.deepEqual(await chart(page, /Разрывы по баллам/), result.gaps.map(gap => {
    const value = Number(gap.current);
    return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2).replace('.', ',')}`;
  }));
  await page.locator('input[value="moscow"]').uncheck();
  result = await submit(page);
  assert.ok(!result.gaps.some(item => item.subject_id === 'moscow'));
  assert.equal(await page.locator('#report').getByText('Москва', {exact: true}).count(), 0);
  const allowed = await submit(page, ai(page), '/api/v1/briefs');
  assert.equal(allowed.brief_mode, 'template');
  assert.match(await page.locator('#status').innerText(), /ИИ недоступен/);
});

test('A19 · недопустимая опора, другая шкала и пропуск базового балла', async page => {
  const catalogue = await (await page.request.get(urls.scale + '/api/v1/rating')).json();
  assert.equal(catalogue.default_baseline, null);
  const noFocus = await (await page.request.get(urls.ria + riaQuery)).json();
  assert.deepEqual(noFocus.gaps, []);
  const outside = await page.request.get(urls.ria + riaQuery + '&focus_subject=moscow');
  assert.equal(outside.status(), 400);
  const url = riaQuery + '&focus_subject=yanao';
  const scale = await (await page.request.get(urls.scale + url)).json();
  const gap = {subject_id: 'khmao-yugra', name: 'Ханты-Мансийский автономный округ — Югра', current: '-8.02', baseline: '-6.93', delta: null};
  assert.deepEqual(scale.gaps, [gap]);
  const missing = await (await page.request.get(urls.missing + url)).json();
  assert.deepEqual(missing.gaps, [{...gap, baseline: null}]);
});

test('A20/A21 · тестовый ИИ и откат на шаблон при трёх отказах', async page => {
  await ready(page, urls.demo);
  await page.locator('#baseline').selectOption('2024');
  const standard = await submit(page);
  const assisted = await submit(page, ai(page), '/api/v1/briefs');
  assert.equal(assisted.brief_mode, 'ai_assisted');
  assert.notDeepEqual(assisted.summary, standard.summary);
  assert.deepEqual(assisted.rows, standard.rows);
  assert.deepEqual(assisted.current.source, standard.current.source);
  assert.match(await page.locator('.summary').innerText(), /с помощью ИИ по рассчитанным фактам/);
  for (const type of ['invalid', 'wrongVariant', 'providerOffline']) {
    await ready(page, urls[type]);
    await page.locator('#baseline').selectOption('2024');
    assert.deepEqual(await submit(page, ai(page), '/api/v1/briefs'), standard);
    assert.match(await page.locator('#status').innerText(), /ИИ недоступен/);
  }
});

test('A24 · ноль, пропуск и несопоставимые места на графиках', async page => {
  await ready(page, urls.partial);
  await page.locator('#baseline').selectOption('2024');
  await submit(page);
  assert.deepEqual(await chart(page, /Изменение балла/), ['+6,50', '−1,50', '+1,00']);
  assert.match(await page.locator('figure').filter({hasText: 'Изменение места'}).innerText(), /Сопоставимых значений для графика нет/);
  await ready(page, urls.zero);
  assert.deepEqual(await chart(page, /Баллы за 2025/), ['82,50', '—', '0,00']);
  assert.deepEqual(await cells(page, 'Таблица сравнения', 'demo-b'), ['2', '—']);
  assert.deepEqual(await cells(page, 'Таблица сравнения', 'demo-c'), ['—', '0,00']);
});

test('A25 · предупреждение об изменении параметров и печать', async page => {
  await ready(page, urls.demo);
  const notice = page.locator('#stale-report');
  await notice.waitFor({state: 'hidden'});
  const changes = [
    [page.locator('#period'), '2024', '2025'],
    [page.locator('#baseline'), '2024', ''],
    [page.locator('#focus'), 'demo-a', ''],
  ];
  for (const [field, changed, original] of changes) {
    await field.selectOption(changed);
    await notice.waitFor({state: 'visible'});
    assert.equal(await notice.innerText(), 'Параметры изменились. Нажмите «Сравнить».');
    await field.selectOption(original);
    await notice.waitFor({state: 'hidden'});
  }
  const extra = page.locator('input[value="demo-d"]');
  await extra.check();
  await notice.waitFor({state: 'visible'});
  assert.equal(await page.getByText('demo-d', {exact: true}).count(), 0);
  await page.emulateMedia({media: 'print'});
  await notice.waitFor({state: 'visible'});
  await page.emulateMedia({media: 'screen'});
  await extra.uncheck();
  await notice.waitFor({state: 'hidden'});
  await extra.check();
  await notice.waitFor({state: 'visible'});
  await submit(page);
  await notice.waitFor({state: 'hidden'});
  assert.deepEqual(await cells(page, 'Таблица сравнения', 'demo-d'), ['1', '89,00']);
});

test('A26 · значок вкладки', async page => {
  await ready(page, urls.demo);
  const icon = await page.locator('link[rel="icon"]').getAttribute('href');
  assert.equal(icon, '/favicon.ico');
  const response = await page.request.get(urls.demo + icon);
  assert.equal(response.status(), 200);
  assert.equal(response.headers()['content-type'], 'image/vnd.microsoft.icon');
  assert.equal((await response.body()).subarray(0, 4).toString('hex'), '00000100');
});

test('A27 · поиск региона с сохранением выбранных субъектов', async page => {
  await ready(page, urls.ria);
  const expanded = riaDataset.subjects.length === 85;
  const search = page.getByRole('searchbox', {name: 'Поиск по названию'});
  await search.fill(expanded ? 'нОВОсибир' : 'сВЕРДЛОВ');
  assert.equal(await page.locator('#subjects label:visible').count(), 1);
  assert.equal(await page.locator('#focus').inputValue(), 'yanao');
  assert.equal(await page.locator('#stale-report').isVisible(), false);
  await page.locator('#subjects input:visible').check();
  await search.fill('несуществующий субъект');
  await page.getByText('Субъекты не найдены.', {exact: true}).waitFor();
  assert.equal(await page.locator('#subject-count').innerText(), 'Выбрано 3');
  await search.clear();
  assert.equal(await page.locator('#subjects input:checked').count(), 3);
  await page.locator('#baseline').selectOption('2024');
  await submit(page);
  if (expanded) {
    assert.deepEqual(await cells(page, 'Таблица сравнения', 'novosibirskaya-oblast'), ['19', '61,52', '18', '63,80', '−1', '−2,28']);
  } else {
    assert.deepEqual(await cells(page, 'Таблица сравнения', 'sverdlovsk-oblast'), ['5', '77,77', '6', '79,41', '+1', '−1,64']);
  }
});

test('A28/A30 · первый экран, готовые группы и источники для проверки', async page => {
  await ready(page, urls.ria);
  const executive = page.locator('#executive');
  assert.equal(await executive.getByRole('heading', {level: 2}).innerText(), 'ЯНАО за минуту');
  assert.equal(await page.locator('#baseline').inputValue(), '2024');
  assert.deepEqual(await executive.locator('.executive-metric strong').allTextContents(), ['10-е из 85', '68,78', '8,02']);
  assert.match(await executive.innerText(), /Отставание выросло на 1,09 · в 2024 году 6,93/);
  assert.ok(await executive.evaluate(el => el.getBoundingClientRect().bottom <= document.querySelector('#comparison-form').getBoundingClientRect().top));
  await executive.getByText('Что проверить', {exact: true}).click();
  assert.deepEqual(await executive.locator('details a').evaluateAll(links => links.map(link => link.href)), [
    'https://rosstat.gov.ru/labour_force', 'https://rosstat.gov.ru/folder/13397', 'https://rosstat.gov.ru/investment_nonfinancial',
  ]);
  assert.equal(await executive.locator('details li').filter({hasText: 'Росстат · 2025 год'}).count(), 3);

  const ural = await submit(page, page.getByRole('button', {name: 'ЯНАО и УрФО', exact: true}));
  assert.deepEqual(ural.rows.map(x => x.subject_id).sort(), [
    'chelyabinsk-oblast', 'khmao-yugra', 'kurgan-oblast', 'sverdlovsk-oblast', 'tyumen-oblast', 'yanao',
  ]);
  assert.equal(ural.focus_subject_id, 'yanao');
  const leaders = await submit(page, page.getByRole('button', {name: 'ЯНАО и лидеры рейтинга', exact: true}));
  assert.deepEqual(leaders.rows.map(x => x.rank), [1, 2, 3, 10]);
  assert.equal(leaders.focus_subject_id, 'yanao');
  const pair = await submit(page, page.getByRole('button', {name: 'ЯНАО и Югра', exact: true}));
  assert.deepEqual(pair.rows.map(x => x.subject_id), ['khmao-yugra', 'yanao']);

  await page.locator('#baseline').selectOption('');
  await submit(page);
  assert.equal(await executive.getByText('Что проверить', {exact: true}).count(), 0);
  await page.setViewportSize({width: 375, height: 812});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
});

test('A29 · справка руководителя на одной странице A4', async page => {
  await page.addInitScript(() => { window.print = () => {}; });
  await ready(page, urls.ria);
  const button = page.getByRole('button', {name: 'Справка на 1 страницу'});
  const notice = page.locator('#executive-stale');
  await page.locator('#baseline').selectOption('');
  await notice.waitFor({state: 'visible'});
  assert.ok(await button.isDisabled());
  await page.locator('#baseline').selectOption('2024');
  await notice.waitFor({state: 'hidden'});
  assert.ok(await button.isEnabled());

  for (const [variant, rows] of [['pair', 2], ['ural', 5]]) {
    if (variant === 'ural') await submit(page, page.getByRole('button', {name: 'ЯНАО и УрФО', exact: true}));
    await button.click();
    await page.emulateMedia({media: 'print'});
    const print = page.locator('#executive-print');
    await print.waitFor({state: 'visible'});
    assert.equal(await page.locator('#report').isVisible(), false);
    assert.equal(await print.locator('tbody tr').count(), rows);
    assert.equal(await print.locator('tbody tr').filter({hasText: 'Ямало-Ненецкий'}).count(), 1);
    assert.equal(await print.locator('.plot-value').count(), 2);
    assert.equal(await print.getByRole('link').count(), 4);
    if (variant === 'ural') assert.match(await print.innerText(), /Показано 5 из 6/);
    const pdf = await page.pdf({path: join(outputDir, `executive-${variant}.pdf`), preferCSSPageSize: true});
    assert.equal(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length, 1);
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await print.waitFor({state: 'hidden'});
    assert.ok(await page.locator('#report').isVisible());
    await page.emulateMedia({media: 'screen'});
  }
});

test('A31 · карта регионов, показатели и добавление к сравнению', async page => {
  await page.route('**/russia-regions.json', route => route.abort('failed'), {times: 1});
  await ready(page, urls.ria);
  const map = page.locator('#regional-map');
  await map.getByText('Не удалось загрузить карту.', {exact: true}).waitFor();
  assert.ok(await page.locator('#report').isVisible());
  await map.getByRole('button', {name: 'Загрузить карту снова'}).click();
  await map.locator('#map-content').waitFor({state: 'visible'});
  assert.equal(await map.locator('svg path').count(), 85);
  assert.equal(await map.locator('svg path.compared').count(), 2);

  const expanded = riaDataset.subjects.length === 85;
  const id = expanded ? 'novosibirskaya-oblast' : 'sverdlovsk-oblast';
  const names = expanded ? ['61,52', '19', '−1', '−2,28'] : ['77,77', '5', '+1', '−1,64'];
  const shape = map.locator(`path[data-region="${id}"]`);
  const metric = map.getByLabel('Показатель');
  for (const [i, key] of ['score', 'rank', 'rank_delta', 'score_delta'].entries()) {
    await metric.selectOption(key);
    assert.equal(await shape.getAttribute('data-value'), names[i]);
  }
  if (!expanded) assert.equal(await map.locator('path[data-region="novosibirskaya-oblast"]').getAttribute('data-value'), '—');

  await map.locator('svg').scrollIntoViewIfNeeded();
  const point = await shape.evaluate(path => {
    const bounds = path.getBBox();
    for (let y = 2; y < 9; y++) {
      for (let x = 2; x < 9; x++) {
        const candidate = new DOMPoint(bounds.x + x * bounds.width / 10, bounds.y + y * bounds.height / 10);
        if (path.isPointInFill(candidate)) return candidate.matrixTransform(path.getScreenCTM()).toJSON();
      }
    }
    throw new Error('У контура отсутствует внутренняя точка');
  });
  await page.mouse.click(point.x, point.y);
  assert.equal(await map.getByLabel('Регион').inputValue(), id);
  assert.equal(await map.locator('dl dd').last().textContent(), names[3]);
  assert.equal(await shape.getAttribute('class'), 'map-region-shape active');
  await map.getByRole('button', {name: 'Увеличить карту'}).click();
  assert.notEqual(await map.locator('svg').getAttribute('viewBox'), '0 0 1000 556');
  await map.getByRole('button', {name: 'Вся карта'}).click();

  const comparison = await submit(page, map.getByRole('button', {name: 'Добавить к сравнению'}));
  assert.equal(comparison.focus_subject_id, 'yanao');
  assert.ok(comparison.rows.some(row => row.subject_id === id));
  assert.equal(comparison.rows.length, 3);
  assert.ok(await map.getByRole('button', {name: 'Уже в сравнении'}).isDisabled());
  await page.locator('#baseline').selectOption('');
  await submit(page);
  await metric.locator('option[value="score_delta"]').waitFor({state: 'detached'});
  assert.equal(await metric.locator('option').count(), 2);
  await page.setViewportSize({width: 375, height: 812});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
});

test('A34 · вход администратора и защищённый ручной запуск', async page => {
  const action = urls.admin + '/admin/api/v1/refresh';
  const good = adminHeader;
  const wrong = `Basic ${Buffer.from(`${adminCredentials.username}:wrong-password`).toString('base64')}`;
  assert.equal((await page.request.get(urls.ria + '/admin/')).status(), 404);
  assert.equal((await page.request.get(urls.admin + '/api/v1/rating')).status(), 200);
  const denied = await page.request.get(urls.admin + '/admin/');
  assert.equal(denied.status(), 401);
  assert.match(denied.headers()['www-authenticate'], /^Basic /);
  assert.equal((await page.request.get(urls.admin + '/admin/', {headers: {Authorization: wrong}})).status(), 401);
  assert.equal((await page.request.post(action, {data: {}})).status(), 401);
  assert.equal((await page.request.post(action, {headers: {Authorization: wrong}, data: {}})).status(), 401);
  assert.equal((await page.request.post(action, {headers: {Authorization: good, Origin: 'https://example.com'}, data: {}})).status(), 403);
  assert.equal((await page.request.post(action, {headers: {Authorization: good}, data: {unexpected: true}})).status(), 400);

  const context = await browser.newContext({httpCredentials: adminCredentials});
  try {
    const admin = await context.newPage();
    assert.equal((await admin.goto(urls.admin + '/admin')).status(), 200);
    await admin.getByRole('heading', {name: 'Панель администратора'}).waitFor();
    const [accepted] = await Promise.all([
      admin.waitForResponse(response => response.url() === action),
      admin.getByRole('button', {name: 'Проверить сейчас'}).click(),
    ]);
    assert.equal(accepted.status(), 202);
    assert.deepEqual(await accepted.json(), {accepted: true});
    assert.equal((await page.request.post(action, {headers: {Authorization: good}, data: {}})).status(), 409);
    await admin.getByText('Проверка запрошена.', {exact: true}).waitFor();
    await admin.locator('#admin-state').filter({hasText: 'Изменений нет'}).waitFor();
    await admin.locator('#admin-history-table tbody tr').filter({hasText: 'Из панели'}).waitFor();
  } finally {
    await context.close();
  }
});

test('A35 · покрытие выпусков и сохранённая история проверок', async page => {
  const endpoint = '/admin/api/v1/analytics';
  assert.equal((await page.request.get(urls.admin + endpoint)).status(), 401);
  const headers = {Authorization: adminHeader};
  const complete = await page.request.get(urls.admin + endpoint, {headers});
  assert.equal(complete.status(), 200);
  const result = await complete.json();
  const count = riaDataset.subjects.length;
  assert.deepEqual([result.subject_count, result.snapshot_count, result.observation_count], [count, 2, count * 2]);
  assert.deepEqual(result.snapshots.map(row => [row.loaded, row.complete, row.missing_rank, row.missing_score]), [
    [count, count, 0, 0], [count, count, 0, 0],
  ]);
  assert.ok(result.recent_runs.some(row => row.trigger === 'scheduled' && row.outcome === 'unchanged'));
  assert.ok(result.recent_runs.some(row => row.trigger === 'manual' && row.outcome === 'unchanged'));
  assert.ok(result.recent_runs.some(row => row.trigger === 'cli' && row.outcome === 'updated'));
  assert.equal(result.refresh_summary.total, result.recent_runs.length - 1);

  const partial = await (await page.request.get(urls.adminPartial + endpoint, {headers})).json();
  assert.equal(partial.observation_count, 7);
  assert.deepEqual(partial.snapshots.map(row => [row.population_size, row.loaded, row.complete, row.missing_rank, row.missing_score]), [
    [4, 4, 2, 1, 1], [4, 3, 3, 0, 0],
  ]);
  assert.deepEqual(partial.refresh_summary, {total: 0, updated: 0, unchanged: 0, errors: 0});

  const context = await browser.newContext({httpCredentials: adminCredentials, viewport: {width: 375, height: 812}});
  try {
    const panel = await context.newPage();
    await panel.goto(urls.admin + '/admin/');
    await panel.getByRole('heading', {name: 'Аналитика данных и загрузок'}).waitFor();
    await panel.locator('#admin-analytics-content').waitFor();
    assert.equal(await panel.locator('#admin-observation-count').innerText(), String(count * 2));
    assert.match(await panel.locator('#admin-coverage-table tbody tr').first().innerText(), new RegExp(`${count} из 85`));
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth), 375);
  } finally {
    await context.close();
  }
});

test('A36 · импорт источника и выбор загруженного рейтинга', async page => {
  const endpoint = urls.admin + '/admin/api/v1/sources';
  const headers = {Authorization: adminHeader, 'Content-Type': 'application/json'};
  assert.equal((await page.request.get(endpoint)).status(), 401);
  assert.equal((await page.request.post(endpoint, {data: {}})).status(), 401);
  const example = await page.request.get(urls.admin + '/admin/example.json', {headers});
  assert.equal(example.status(), 200);
  const dataset = await example.json();
  dataset.rating_id = 'e2e-new-source';
  dataset.rating_title = 'Рейтинг из нового источника';
  for (const subject of dataset.subjects) subject.subject_id = subject.subject_id.replace('demo-', 'new-');
  for (const snapshot of dataset.snapshots) {
    for (const row of snapshot.rows) row.subject_id = row.subject_id.replace('demo-', 'new-');
  }
  const [current, previous] = dataset.snapshots;
  current.source = {title: 'Тестовая публикация', reference: 'https://example.com/rating', published_on: '2026-02-01'};
  dataset.snapshots = [current];

  const context = await browser.newContext({httpCredentials: adminCredentials});
  try {
    const panel = await context.newPage();
    await panel.goto(urls.admin + '/admin/');
    await panel.getByLabel('Файл рейтинга').setInputFiles({
      name: 'rating.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(dataset)),
    });
    const accepted = panel.waitForResponse(res => res.url() === endpoint && res.request().method() === 'POST');
    await panel.getByRole('button', {name: 'Добавить источник'}).click();
    assert.equal((await accepted).status(), 201);
    await panel.locator('#admin-import-status').filter({hasText: '2025'}).waitFor();
    await panel.getByRole('link', {name: dataset.rating_title}).click();
    await panel.locator('#report').waitFor();
    assert.equal(await panel.locator('#rating-title').innerText(), dataset.rating_title);
    assert.match(await panel.locator('#report').innerText(), /Тестовая публикация/);
  } finally {
    await context.close();
  }

  const save = snapshots => page.request.post(endpoint, {headers, data: {...dataset, snapshots}});
  assert.equal((await save([previous])).status(), 201);
  assert.equal((await save([current, {...previous, period: '2023'}])).status(), 409);
  assert.equal((await page.request.post(endpoint, {headers, data: '{'})).status(), 400);
  const {sources} = await (await page.request.get(endpoint, {headers})).json();
  assert.deepEqual(sources.filter(row => row.rating_id === dataset.rating_id).map(row => row.period), ['2025', '2024']);
  const defaultRating = await (await page.request.get(urls.admin + '/api/v1/rating')).json();
  assert.equal(defaultRating.rating_id, riaDataset.rating_id);
});

test('A37 · регистрация по email, кабинет аналитика и выход', async page => {
  const ratings = urls.auth + '/workspace/api/v1/ratings';
  const emailEndpoint = urls.auth + '/auth/api/v1/email';
  const verifyEndpoint = urls.auth + '/auth/api/v1/verify';
  const email = 'analyst@example.test';
  assert.equal((await page.request.get(ratings)).status(), 401);
  assert.equal((await page.request.post(emailEndpoint, {data: {email: 'a@'}})).status(), 400);
  assert.equal((await page.request.post(urls.ria + '/auth/api/v1/email', {data: {email}})).status(), 503);

  await page.goto(urls.auth + '/workspace/');
  assert.ok(page.url().endsWith('/login/'));
  await page.getByLabel('Email', {exact: true}).fill('Analyst@example.test');
  await page.getByRole('button', {name: 'Получить ссылку'}).click();
  await page.getByRole('status').filter({hasText: 'Проверьте почту'}).waitFor();

  const messages = async () => (await readFile(urls.mailbox, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const [{email: recipient, link}] = await messages();
  assert.equal(recipient, email);
  assert.equal((await page.request.post(emailEndpoint, {data: {email}})).status(), 202);
  assert.equal((await messages()).length, 1);
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token');
  await page.goto(link);
  assert.equal((await page.request.get(ratings)).status(), 401);
  await page.getByRole('button', {name: 'Подтвердить вход'}).click();
  await page.waitForURL('**/workspace/');
  await page.locator('#workspace-email').filter({hasText: email}).waitFor();
  await page.getByRole('button', {name: 'Помощник', exact: true}).click();
  const help = page.getByRole('dialog', {name: 'Помощник по сервису'});
  await help.getByLabel('Что хотите узнать?').fill('Что делает эта панель?');
  await help.getByRole('button', {name: 'Спросить', exact: true}).click();
  assert.match(await help.getByRole('status').innerText(), /доступные рейтинги и годы выпусков/);
  await help.getByRole('button', {name: 'Закрыть', exact: true}).click();
  assert.equal((await page.request.post(verifyEndpoint, {data: {token}})).status(), 400);
  assert.equal((await page.request.get(urls.auth + '/admin/api/v1/sources')).status(), 401);
  const cookie = (await page.context().cookies()).find(item => item.name === 'i16_workspace');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Lax');
  assert.equal((await page.request.get(urls.ria + '/workspace/api/v1/ratings')).status(), 200);
  await page.getByRole('link', {name: 'Рейтинг из нового источника'}).click();
  await page.locator('#report').waitFor();
  await page.locator('#baseline').selectOption('2024');
  const comparison = await submit(page);
  assert.equal(comparison.rating_title, 'Рейтинг из нового источника');
  assert.equal(comparison.baseline.period, '2024');
  await page.getByRole('link', {name: 'Рабочая область'}).click();
  await page.getByRole('button', {name: 'Выйти'}).click();
  await page.waitForURL('**/login/');
  assert.equal((await page.request.get(ratings, {headers: {Cookie: `${cookie.name}=${cookie.value}`}})).status(), 401);

  assert.equal((await page.request.post(emailEndpoint, {data: {email: 'expired@example.test'}})).status(), 202);
  const expiredLink = (await messages()).find(item => item.email === 'expired@example.test').link;
  await page.goto(expiredLink);
  await page.getByRole('button', {name: 'Подтвердить вход'}).click();
  await page.getByRole('status').filter({hasText: 'Ссылка истекла'}).waitFor();
});

test('A38 · помощник отвечает на вопросы о разделах и ведёт к панели', async page => {
  await ready(page, urls.ria);
  await page.locator('#regional-map').waitFor();
  await page.getByRole('button', {name: 'Помощник', exact: true}).click();
  const help = page.getByRole('dialog', {name: 'Помощник по сервису'});
  const input = help.getByLabel('Что хотите узнать?');
  const answer = help.getByRole('status');
  const ask = async question => {
    await input.fill(question);
    await help.getByRole('button', {name: 'Спросить', exact: true}).click();
  };
  await ask('Объясни, что показывают цвета на карте');
  assert.match(await answer.innerText(), /балл или место каждого региона/);
  await answer.getByRole('link', {name: 'Перейти к разделу'}).click();
  assert.ok(page.url().endsWith('#regional-map'));
  assert.equal(await help.isVisible(), false);

  await page.setViewportSize({width: 375, height: 812});
  await page.getByRole('button', {name: 'Помощник', exact: true}).click();
  await ask('Зачем нужен базовый год?');
  assert.match(await answer.innerText(), /Базовый период — год/);
  assert.ok((await help.boundingBox()).width <= 375);
  await ask('Какой рецепт борща?');
  assert.match(await answer.innerText(), /Выберите тему выше/);
  await help.getByRole('button', {name: 'Параметры сравнения'}).click();
  assert.match(await answer.innerText(), /минимум два субъекта/);
  await page.keyboard.press('Escape');
  assert.equal(await help.isVisible(), false);

  const context = await browser.newContext({httpCredentials: adminCredentials});
  try {
    const panel = await context.newPage();
    await panel.goto(urls.admin + '/admin/');
    await panel.getByRole('button', {name: 'Помощник', exact: true}).click();
    const adminHelp = panel.getByRole('dialog');
    await adminHelp.getByLabel('Что хотите узнать?').fill('Где посмотреть журнал последних запусков?');
    await adminHelp.getByRole('button', {name: 'Спросить', exact: true}).click();
    const explanation = adminHelp.getByRole('status');
    assert.match(await explanation.innerText(), /Журнал показывает/);
    assert.equal(await explanation.getByRole('link').getAttribute('href'), '#admin-analytics-title');
  } finally {
    await context.close();
  }
});

if (urls.live) {
  test('T09 · живая модель на публичной выборке РИА', async page => {
    page.setDefaultTimeout(15000);
    await ready(page, urls.live);
    await page.locator('#baseline').selectOption('2024');
    await page.locator('input[value="tyumen-oblast"]').check();
    const {summary: standardSummary, brief_mode: standardMode, ...standard} = await submit(page);
    assert.equal(standardMode, 'template');
    assert.ok(standardSummary.length);
    const {summary, brief_mode: mode, ...assisted} = await submit(page, ai(page), '/api/v1/briefs');
    assert.equal(mode, 'ai_assisted', 'Сервис не вернул допустимый выбор рассчитанных фактов');
    assert.ok(summary.length);
    assert.deepEqual(assisted, standard);
    assert.match(await page.locator('.summary').innerText(), /с помощью ИИ по рассчитанным фактам/);
  });
}

let failed = 0;
try {
  for (const {name, run} of cases) {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    try {
      await run(page);
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}\n${error.stack}`);
      const screenshot = join(outputDir, `${name.split(' · ')[0].replace(/[^a-z0-9-]+/gi, '-')}.png`);
      try {
        await page.screenshot({path: screenshot, fullPage: true, timeout: 3000});
        console.error(`Снимок экрана: ${screenshot}`);
      } catch (screenshotError) {
        console.error(`Не удалось сохранить снимок: ${screenshotError.message}`);
      }
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`${cases.length - failed}/${cases.length} web/API test groups passed`);
if (failed) process.exitCode = 1;
