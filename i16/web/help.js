(() => {
  const open = document.querySelector('[data-help-page]');
  if (!open) return;

  const topics = {
    comparison: {
      title: 'Параметры сравнения',
      words: 'сравн сравни субъект выбра параметр',
      page: 'rating', target: '#comparison-form',
      text: 'Выберите текущий год и минимум два субъекта. Поиск ограничивает список на экране и сохраняет уже отмеченные субъекты. Нажмите «Сравнить», чтобы обновить таблицу и графики.',
    },
    baseline: {
      title: 'Базовый период',
      words: 'базов динамик дельт изменен прошл прирост',
      phrases: ['с прошлым', 'с чем сравни'],
      page: 'rating', target: '#baseline',
      text: 'Базовый период — год, с которым сравниваются текущие баллы и места. Выберите его в параметрах и снова нажмите «Сравнить». Если методика, шкала или состав рейтинга не позволяют сравнить показатели, справка объяснит ограничение.',
    },
    focus: {
      title: 'Опорный субъект',
      words: 'опорн разрыв отставан лидир',
      phrases: ['относительно региона'],
      page: 'rating', target: '#focus',
      text: 'Опорный субъект задаёт точку отсчёта для разрывов с остальными выбранными регионами. Выберите его из списка участвующих субъектов и нажмите «Сравнить». Разрывы покажут, на сколько мест и баллов регионы отличаются от опоры в текущем выпуске.',
    },
    report: {
      title: 'Таблица и графики',
      words: 'таблиц график балл мест прочерк пропуск результат легенд',
      page: 'rating', target: '#report',
      text: 'Таблица показывает опубликованные места и баллы выбранных регионов. Графики помогают сравнить показатели и увидеть изменения, когда выбрана сопоставимая база. Прочерк означает, что значение отсутствует. Сведения об источниках находятся в справке.',
    },
    map: {
      title: 'Карта регионов России',
      words: 'карт географ контур окраш легенд',
      phrases: ['показатель на карте'],
      page: 'rating', target: '#regional-map', localOnly: true,
      text: 'Карта рейтинга РИА показывает балл или место каждого региона. При выбранном базовом периоде доступны сопоставимые изменения. Нажмите на регион, чтобы увидеть его значения и добавить его к сравнению.',
    },
    executive: {
      title: 'Справка для руководителя',
      words: 'руководител печат распечат страниц сводк',
      phrases: ['одна страница', 'на 1 страницу'],
      page: 'rating', target: '#executive', localOnly: true,
      text: 'На первом экране рейтинга РИА собраны главные результаты сравнения. Кнопка «Справка на 1 страницу» открывает печать краткой сводки. Подробные значения и ограничения доступны ниже в сравнении.',
    },
    assisted: {
      title: 'Справка с ИИ',
      words: 'ии нейросет модел',
      phrases: ['искусственный интеллект', 'справка с ии'],
      page: 'rating', target: '#comparison-form',
      text: 'Кнопка «Справка с ИИ» просит модель подобрать порядок и формулировки для уже рассчитанных фактов. Баллы, места и источники берутся из рейтинга. При сбое модели сервис показывает справку по шаблону.',
    },
    workspace: {
      title: 'Рабочая область аналитика',
      words: 'кабинет каталог рейтинг',
      phrases: ['рабочая область', 'список рейтингов'],
      page: 'workspace', target: '#workspace-ratings-heading',
      text: 'Рабочая область показывает доступные рейтинги и годы выпусков. Нажмите на название рейтинга, затем выберите годы и регионы на странице сравнения. Для входа в рабочую область нужна ссылка из письма.',
    },
    login: {
      title: 'Регистрация и вход по email',
      words: 'почт email smtp письм регистрац войти вход аккаунт сесси',
      phrases: ['ссылка из письма', 'подтвердить вход'],
      page: 'login', target: '#email-heading',
      text: 'Введите email и нажмите «Получить ссылку». Откройте письмо и подтвердите вход в течение 15 минут. Первый вход создаёт учётную запись. Если письмо не пришло, проверьте спам и запросите свежую ссылку через минуту.',
    },
    sources: {
      title: 'Источники данных',
      words: 'источ импорт загрузить json издател публикаци набор',
      phrases: ['источники данных', 'новый источник', 'добавить источник', 'загрузить выпуск', 'откуда данные'],
      page: 'admin', target: '#admin-sources-title',
      text: 'В админке видны источник и дата публикации каждого выпуска. Для добавления загрузите JSON по образцу из панели. Для нового рейтинга задайте новый ID. Чтобы добавить периоды к существующему, включите в файл только новые выпуски.',
    },
    refresh: {
      title: 'Обновление рейтинга РИА',
      words: 'обнов провер расписан автоматически',
      phrases: ['проверить сейчас', 'проверка источника', 'проверки источника', 'обновление рейтинга'],
      page: 'admin', target: '#admin-refresh-title',
      text: 'Раздел показывает состояние и время последней и следующей проверки таблицы РИА. «Проверить сейчас» запускает ту же проверку вручную, если включено расписание. При ошибке сервис продолжает использовать последнюю корректную загрузку.',
    },
    quality: {
      title: 'Аналитика данных и загрузок',
      words: 'аналитик покрыти журнал истор наблюден полнот загружен',
      phrases: ['аналитика данных', 'качество данных', 'сколько регионов', 'история проверок'],
      page: 'admin', target: '#admin-analytics-title',
      text: 'Панель показывает число регионов, выпусков и наблюдений. По каждому выпуску можно сверить покрытие с опубликованным размером и увидеть пропуски места или балла. Журнал показывает, когда и как запускались проверки, и чем они завершились.',
    },
  };
  const page = open.dataset.helpPage;
  const pages = {rating: '/', workspace: '/workspace/', login: '/login/', admin: '/admin/'};
  const suggestions = {
    rating: ['comparison', 'baseline', 'map'],
    workspace: ['workspace', 'comparison', 'login'],
    login: ['login', 'workspace', 'comparison'],
    admin: ['sources', 'quality', 'refresh'],
  };
  const context = {rating: 'comparison', workspace: 'workspace', login: 'login', admin: 'quality'};
  const dialog = document.createElement('dialog');
  dialog.className = 'service-help';
  dialog.setAttribute('aria-labelledby', 'help-title');
  dialog.innerHTML = `
    <div class="help-header">
      <h2 id="help-title">Помощник по сервису</h2>
      <button type="button" class="secondary" id="help-close">Закрыть</button>
    </div>
    <form>
      <label for="help-question">Что хотите узнать?</label>
      <textarea id="help-question" rows="2" maxlength="280" required></textarea>
      <button type="submit">Спросить</button>
    </form>
    <div class="help-examples" role="group" aria-label="Темы для примера"></div>
    <div class="help-response" role="status" aria-atomic="true"></div>`;
  document.body.append(dialog);

  const question = dialog.querySelector('textarea');
  const answer = dialog.querySelector('.help-response');
  const examples = dialog.querySelector('.help-examples');
  const normalize = value => (value.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е')
    .match(/[а-яa-z0-9]+/g) ?? []).join(' ');

  function choose(value) {
    const normalized = normalize(value);
    const words = new Set(normalized.split(' '));
    const ranked = Object.entries(topics).map(([key, topic]) => {
      const terms = topic.words.split(' ');
      const matches = [...words].filter(word => terms.some(term => word.startsWith(term))).length;
      const phrase = topic.phrases?.some(item => normalized.includes(item)) ? 4 : 0;
      const exact = normalized === normalize(topic.title) ? 10 : 0;
      return {key, score: matches + phrase + exact};
    }).sort((a, b) => b.score - a.score);
    if (ranked[0].score > 0) {
      return ranked.filter(match => match.score === ranked[0].score).slice(0, 2).map(match => match.key);
    }
    if ([...words].some(word => ['панел', 'экран', 'здесь', 'тут', 'эта'].some(term => word.startsWith(term)))) {
      const current = Object.keys(topics).find(key => topics[key].page === page && topics[key].target === location.hash);
      return [current ?? context[page]];
    }
    return [];
  }

  function show(keys) {
    answer.replaceChildren();
    if (!keys.length) {
      answer.textContent = 'Я отвечаю на вопросы о разделах И16. Выберите тему выше или напишите название панели.';
      return;
    }
    for (const key of keys) {
      const topic = topics[key];
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      const text = document.createElement('p');
      heading.textContent = topic.title;
      text.textContent = topic.text;
      section.append(heading, text);
      const visible = topic.page === page && document.querySelector(topic.target)?.getClientRects().length;
      if (visible || (topic.page !== page && !topic.localOnly)) {
        const link = document.createElement('a');
        link.href = visible ? topic.target : pages[topic.page] + topic.target;
        link.textContent = 'Перейти к разделу';
        link.addEventListener('click', () => dialog.close());
        section.append(link);
      }
      answer.append(section);
    }
  }

  for (const key of suggestions[page]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = topics[key].title;
    button.addEventListener('click', () => {
      question.value = topics[key].title;
      show([key]);
    });
    examples.append(button);
  }
  open.addEventListener('click', () => {
    dialog.showModal();
    question.focus();
  });
  dialog.querySelector('#help-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    show(choose(question.value));
  });
})();
