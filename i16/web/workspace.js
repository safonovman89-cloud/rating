const notice = document.querySelector('#workspace-status');
const emailForm = document.querySelector('#email-form');
const verifyForm = document.querySelector('#verify-form');

async function request(url, data) {
  const response = await fetch(url, data === undefined ? undefined : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data),
  });
  const body = await response.json();
  if (response.status === 401) {
    location.replace('/login/');
  }
  if (!response.ok) throw new Error(body.error?.message ?? 'Запрос не выполнен.');
  return body;
}

function configureLogin() {
  let token;
  const verify = verifyForm.querySelector('button');
  function showConfirmation() {
    const received = new URLSearchParams(location.hash.slice(1)).get('token');
    if (received === null) return;
    token = received;
    history.replaceState(null, '', location.pathname);
    emailForm.hidden = true;
    verifyForm.hidden = false;
    verify.disabled = false;
    notice.textContent = '';
  }
  showConfirmation();
  window.addEventListener('hashchange', showConfirmation);
  emailForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = emailForm.querySelector('button');
    button.disabled = true;
    notice.textContent = 'Отправляем письмо…';
    try {
      await request('/auth/api/v1/email', {email: emailForm.elements.email.value});
      notice.textContent = 'Проверьте почту. Ссылка действует 15 минут. Повторный запрос доступен через минуту.';
    } catch (error) {
      notice.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  verifyForm.addEventListener('submit', async event => {
    event.preventDefault();
    verify.disabled = true;
    try {
      await request('/auth/api/v1/verify', {token});
      location.replace('/workspace/');
    } catch (error) {
      notice.textContent = error.message;
      verifyForm.hidden = true;
      emailForm.hidden = false;
      emailForm.elements.email.focus();
    }
  });
}

function ratingItem(rating) {
  const item = document.createElement('li');
  const link = document.createElement('a');
  link.href = `/?rating_id=${encodeURIComponent(rating.rating_id)}`;
  link.textContent = rating.title;
  const detail = document.createElement('p');
  detail.className = 'note';
  detail.textContent = `Выпуски: ${rating.periods.join(', ')}${rating.data_kind === 'demo' ? ' · Демонстрационные данные' : ''}`;
  item.append(link, detail);
  return item;
}

async function loadWorkspace() {
  const logout = document.querySelector('#logout');
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      await request('/auth/api/v1/logout', {});
      location.replace('/login/');
    } catch (error) {
      notice.textContent = error.message;
      logout.disabled = false;
    }
  });
  try {
    const {email, ratings} = await request('/workspace/api/v1/ratings');
    document.querySelector('#workspace-email').textContent = email;
    document.querySelector('#workspace-ratings').replaceChildren(...ratings.map(ratingItem));
    notice.textContent = ratings.length ? '' : 'Рейтинги пока не загружены.';
  } catch (error) {
    notice.textContent = error.message;
  }
}

if (emailForm) configureLogin();
else loadWorkspace();
