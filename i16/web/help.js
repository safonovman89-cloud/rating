(async () => {
  const open = document.querySelector('[data-help-page]');
  if (!open) return;
  open.disabled = true;
  let topics;
  try {
    const response = await fetch('/help-topics.json');
    if (!response.ok) throw new Error();
    topics = await response.json();
  } catch {
    open.title = 'Справочник помощника не загрузился. Обновите страницу.';
    return;
  }

  const page = open.dataset.helpPage;
  const pages = {rating: '/', workspace: '/workspace/', login: '/login/', admin: '/admin/'};
  const suggestions = {
    rating: ['comparison', 'baseline', 'map'],
    workspace: ['workspace', 'comparison', 'login'],
    login: ['login', 'workspace', 'comparison'],
    admin: ['sources', 'quality', 'refresh'],
  };
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
  const submit = dialog.querySelector('button[type="submit"]');
  function show(keys, generated, fromModel) {
    const origin = document.createElement('p');
    origin.className = 'note';
    origin.textContent = fromModel ? 'Ответ LLM' : 'Ответ из справочника';
    answer.replaceChildren(origin);
    if (generated) {
      const explanation = document.createElement('p');
      explanation.className = 'help-generated';
      explanation.textContent = generated;
      answer.append(explanation);
    }
    if (!keys.length) {
      const explanation = document.createElement('p');
      explanation.textContent = 'Я отвечаю на вопросы о разделах И16. Выберите тему выше или напишите название панели.';
      answer.append(explanation);
      return;
    }
    for (const key of keys) {
      const topic = topics[key];
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      const text = document.createElement('p');
      heading.textContent = topic.title;
      text.textContent = topic.text;
      section.append(heading);
      if (!fromModel) section.append(text);
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

  async function ask() {
    if (submit.disabled) return;
    const value = question.value.trim();
    if (!value) {
      answer.textContent = 'Введите вопрос.';
      return;
    }
    submit.disabled = true;
    answer.textContent = 'Модель готовит ответ…';
    try {
      const response = await fetch('/api/v1/help', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({question: value, page, section: location.hash || null}),
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      show(result.topics, result.answer, result.mode === 'llm');
    } catch {
      answer.textContent = 'Помощник временно недоступен. Повторите вопрос.';
    } finally {
      submit.disabled = false;
    }
  }

  for (const key of suggestions[page]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = topics[key].title;
    button.addEventListener('click', () => {
      if (submit.disabled) return;
      question.value = topics[key].title;
      ask();
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
    ask();
  });
  open.disabled = false;
})();
