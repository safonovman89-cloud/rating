const svgNamespace = 'http://www.w3.org/2000/svg';
const noData = {label: 'Нет данных', color: '#e4e7e6'};
const deltaScale = [
  {label: 'Снижение на 5 и более', color: '#a32948', matches: value => value <= -5},
  {label: 'Снижение менее чем на 5', color: '#e6aebb', matches: value => value < 0},
  {label: 'Без изменений', color: '#ece8d5', matches: value => value === 0},
  {label: 'Рост менее чем на 5', color: '#acd1c6', matches: value => value < 5},
  {label: 'Рост на 5 и более', color: '#246f60', matches: () => true},
];
const indicators = {
  score: {label: 'Балл', scale: [
    {label: 'Менее 25', color: '#efe1e7', matches: value => value < 25},
    {label: 'От 25 до 50', color: '#dfacba', matches: value => value < 50},
    {label: 'От 50 до 75', color: '#bd5471', matches: value => value < 75},
    {label: '75 и выше', color: '#891535', matches: () => true},
  ]},
  rank: {label: 'Место', scale: [
    {label: '1–10', color: '#205f52', matches: value => value <= 10},
    {label: '11–30', color: '#4e8f81', matches: value => value <= 30},
    {label: '31–60', color: '#8cbdb0', matches: value => value <= 60},
    {label: '61 и ниже', color: '#cfe0dc', matches: () => true},
  ]},
  rank_delta: {label: 'Изменение места', scale: deltaScale, signed: true},
  score_delta: {label: 'Изменение балла', scale: deltaScale, signed: true},
};
const scales = [1, 1.6, 2.5, 4];

export function createRegionMap({request, element, sourceLink, valueText, addSubject}) {
  const panel = document.querySelector('#regional-map');
  const content = panel.querySelector('#map-content');
  const context = panel.querySelector('#map-context');
  const chart = panel.querySelector('#map-shapes');
  const indicator = panel.querySelector('#map-indicator');
  const region = panel.querySelector('#map-region');
  const details = panel.querySelector('#map-region-values');
  const legend = panel.querySelector('#map-legend');
  const status = panel.querySelector('#map-status');
  const limits = panel.querySelector('#map-limits');
  const retry = panel.querySelector('#map-retry');
  const add = panel.querySelector('#map-add');
  const zoomIn = panel.querySelector('#map-zoom-in');
  const zoomOut = panel.querySelector('#map-zoom-out');
  const reset = panel.querySelector('#map-reset');
  const paths = new Map();
  let geometry;
  let geometryRequest;
  let data;
  let report;
  let dataKey;
  let version = 0;
  let comparable = new Map();
  let zoom = 0;
  let stale = false;

  function updateAdd() {
    const included = report?.rows.some(row => row.subject_id === region.value);
    add.textContent = included ? 'Уже в сравнении' : 'Добавить к сравнению';
    add.disabled = stale || included || !comparable.has(region.value);
  }

  function setStale(value) {
    stale = value;
    updateAdd();
  }

  function renderViewBox() {
    const [left, top, width, height] = geometry.view_box;
    const scale = scales[zoom];
    const w = width / scale;
    const h = height / scale;
    const shape = paths.get(region.value)?.getBBox();
    const centerX = shape ? shape.x + shape.width / 2 : left + width / 2;
    const centerY = shape ? shape.y + shape.height / 2 : top + height / 2;
    const x = Math.max(left, Math.min(left + width - w, centerX - w / 2));
    const y = Math.max(top, Math.min(top + height - h, centerY - h / 2));
    chart.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    zoomIn.disabled = zoom === scales.length - 1;
    zoomOut.disabled = reset.disabled = zoom === 0;
  }

  function choose(id) {
    paths.get(region.value)?.classList.remove('active');
    region.value = id;
    paths.get(id)?.classList.add('active');
    const row = comparable.get(id);
    const year = data.current.period;
    const fields = [[`Место ${year}`, row?.rank], [`Балл ${year}`, row?.score]];
    if (data.baseline) {
      const base = data.baseline.period;
      fields.push([`Место ${base}`, row?.baseline_rank], [`Балл ${base}`, row?.baseline_score],
        ['Изменение места', row?.rank_delta, true], ['Изменение балла', row?.score_delta, true]);
    }
    details.replaceChildren(...fields.flatMap(([label, value, signed]) => [
      element('dt', label), element('dd', valueText(value ?? null, signed)),
    ]));
    details.setAttribute('aria-label', geometry.regions[id].name);
    updateAdd();
    renderViewBox();
  }

  function paint() {
    const key = indicator.value;
    const {label, scale, signed} = indicators[key];
    const selected = new Set(report.rows.map(row => row.subject_id));
    for (const [id, path] of paths) {
      const value = comparable.get(id)?.[key];
      const category = value == null ? noData : scale.find(bin => bin.matches(Number(value)));
      path.setAttribute('fill', category.color);
      path.dataset.value = valueText(value ?? null, signed);
      path.firstChild.textContent = `${geometry.regions[id].name} · ${label} · ${value == null ? noData.label : path.dataset.value}`;
      path.classList.toggle('compared', selected.has(id));
    }
    legend.replaceChildren(...[...scale, noData].map(({label, color}) => {
      const item = element('li');
      const swatch = element('span', undefined, 'map-swatch');
      swatch.style.backgroundColor = color;
      item.append(swatch, label);
      return item;
    }));
    const unavailable = signed && ![...comparable.values()].some(row => row[key] != null);
    limits.hidden = !unavailable;
    limits.textContent = unavailable ? data.limits[0] || 'Сопоставимых значений для этого показателя нет.' : '';
  }

  function drawShapes() {
    const entries = Object.entries(geometry.regions).sort(([, a], [, b]) => a.name.localeCompare(b.name, 'ru'));
    for (const [id, {path: commands}] of entries) {
      const path = document.createElementNS(svgNamespace, 'path');
      path.classList.add('map-region-shape');
      path.dataset.region = id;
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('d', commands);
      path.append(document.createElementNS(svgNamespace, 'title'));
      paths.set(id, path);
    }
    chart.setAttribute('viewBox', geometry.view_box.join(' '));
    chart.style.aspectRatio = `${geometry.view_box[2]} / ${geometry.view_box[3]}`;
    chart.replaceChildren(...paths.values());
    region.replaceChildren(...entries.map(([id, {name}]) => new Option(name, id)));
  }

  function render() {
    const original = indicator.value;
    const keys = data.baseline ? Object.keys(indicators) : ['score', 'rank'];
    indicator.replaceChildren(...keys.map(key => new Option(indicators[key].label, key)));
    if (keys.includes(original)) indicator.value = original;
    const id = region.value;
    const initial = report.focus_subject_id ?? report.rows[0].subject_id;
    if (!paths.size) drawShapes();
    content.hidden = false;
    indicator.disabled = false;
    const snapshots = [data.current, data.baseline].filter(Boolean);
    context.replaceChildren(...snapshots.flatMap(({period, source}, index) => [
      `${index ? ' · База ' : 'Период '}${period} · `, sourceLink(source.title, source.reference),
    ]));
    paint();
    choose(paths.has(id) ? id : paths.has(initial) ? initial : region.value);
  }

  async function update(result) {
    report = result;
    panel.hidden = false;
    const query = new URLSearchParams({period: result.current.period});
    if (result.baseline) query.set('baseline', result.baseline.period);
    const key = query.toString();
    const currentVersion = ++version;
    retry.hidden = true;
    const samePeriods = dataKey === key;
    content.hidden = !samePeriods;
    indicator.disabled = true;
    status.hidden = samePeriods;
    status.textContent = 'Загружаем карту…';
    try {
      geometryRequest ??= request('/russia-regions.json').catch(error => {
        geometryRequest = undefined;
        throw error;
      });
      const [boundaries, response] = await Promise.all([geometryRequest, request(`/api/v1/map?${query}`)]);
      if (version !== currentVersion) return;
      geometry = boundaries;
      data = response;
      dataKey = key;
      comparable = new Map(data.rows.map(row => [row.subject_id, row]));
      status.hidden = true;
      render();
    } catch {
      if (version !== currentVersion) return;
      content.hidden = true;
      status.hidden = false;
      retry.hidden = false;
      status.textContent = 'Не удалось загрузить карту.';
    }
  }

  indicator.addEventListener('change', paint);
  region.addEventListener('change', () => {
    chart.querySelector('.active')?.classList.remove('active');
    choose(region.value);
  });
  chart.addEventListener('click', event => {
    const id = event.target.closest('[data-region]')?.dataset.region;
    if (id) choose(id);
  });
  zoomIn.addEventListener('click', () => { zoom++; renderViewBox(); });
  zoomOut.addEventListener('click', () => { zoom--; renderViewBox(); });
  reset.addEventListener('click', () => { zoom = 0; renderViewBox(); });
  add.addEventListener('click', () => addSubject(region.value));
  retry.addEventListener('click', () => update(report));
  return {update, setStale};
}
