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
  assert.equal(await page.locator('form').isVisible(), false);
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
