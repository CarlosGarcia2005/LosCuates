// =====================================================
//  Login en dos pasos - Gestor Deportivo Rancho Seco
//  1) correo + contraseña   2) código MFA (Authenticator)
// =====================================================
(function () {
  'use strict';
  const { api, mostrarErrores, limpiarErrores, limpiarAlEscribir, soloDigitos } = window.App;

  const formLogin = document.getElementById('formLogin');
  const formMfa = document.getElementById('formMfa');
  const btnLogin = document.getElementById('btnLogin');
  const btnMfa = document.getElementById('btnMfa');
  const inputPass = document.getElementById('contrasena');
  const inputCodigo = document.getElementById('codigo');
  const btnVer = document.getElementById('verContrasena');
  const card = document.querySelector('.card');

  document.getElementById('anio').textContent = new Date().getFullYear();

  // [OWASP A01] Aviso cuando el servidor cerró la sesión por una manipulación
  const motivo = new URLSearchParams(window.location.search).get('motivo');
  const MOTIVOS = {
    seguridad: 'Cerramos tu sesión porque detectamos una modificación no permitida ' +
      '(datos o permisos alterados desde el navegador). Si fuiste tú, vuelve a iniciar sesión.',
    // [OWASP A07]
    inactividad: 'Cerramos tu sesión porque pasaron 15 minutos sin actividad. Vuelve a iniciar sesión.',
    maximo: 'Tu sesión llegó al máximo de 8 horas. Por seguridad, vuelve a iniciar sesión.'
  };
  if (MOTIVOS[motivo]) {
    mostrarErrores(formLogin, {}, MOTIVOS[motivo]);
    window.history.replaceState(null, '', '/');
  }

  // Si ya hay sesión, ir directo al panel
  api('GET', '/api/auth/sesion').then((r) => {
    if (r.ok && r.datos.usuario) {
      window.location.href = r.datos.usuario.nivel === 'Administrador' ? '/admin' : '/perfil';
    }
  });

  // Ojo cerrado = contraseña oculta; ojo abierto = se ve el texto
  const OJO_ABIERTO = [['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' }], ['circle', { cx: '12', cy: '12', r: '3' }]];
  const OJO_CERRADO = [['path', { d: 'M3 3l18 18' }],
    ['path', { d: 'M10.6 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.5' }],
    ['path', { d: 'M9.9 9.9a3 3 0 0 0 4.2 4.2' }]];
  const pintarOjo = (visible) => {
    const svg = window.App.svgIcono(visible ? OJO_ABIERTO : OJO_CERRADO);
    svg.setAttribute('stroke-width', '1.8');
    btnVer.replaceChildren(svg);
    btnVer.classList.toggle('activo', visible);
    btnVer.setAttribute('aria-label', visible ? 'Ocultar contraseña' : 'Mostrar contraseña');
  };
  pintarOjo(false);
  btnVer.addEventListener('click', () => {
    const visible = inputPass.type === 'password';
    inputPass.type = visible ? 'text' : 'password';
    pintarOjo(visible);
  });

  limpiarAlEscribir(formLogin);
  limpiarAlEscribir(formMfa);
  soloDigitos(inputCodigo);

  function textoBoton(boton, texto, deshabilitar) {
    boton.disabled = deshabilitar;
    boton.querySelector('span').textContent = texto;
  }

  function mostrarPaso(paso, datos = {}) {
    const esMfa = paso !== 'credenciales';
    formLogin.hidden = esMfa;
    formMfa.hidden = !esMfa;
    document.getElementById('hintContrasena').hidden = esMfa;
    card.classList.toggle('card--mfa', esMfa);

    const titulo = document.getElementById('cardTitulo');
    const subtitulo = document.getElementById('cardSubtitulo');
    const config = document.getElementById('mfaConfig');

    if (paso === 'configurar') {
      titulo.textContent = 'Activa la verificación en dos pasos';
      subtitulo.textContent = 'Es la primera vez que entras. Vincula tu celular para proteger tu cuenta.';
      config.hidden = false;
      document.getElementById('mfaQr').src = datos.qr;
      document.getElementById('mfaSecreto').textContent = datos.secreto;
      document.getElementById('mfaCuenta').textContent = datos.cuenta;
    } else if (paso === 'verificar') {
      titulo.textContent = 'Verificación en dos pasos';
      subtitulo.textContent = 'Escribe el código de 6 dígitos que muestra tu app Authenticator.';
      config.hidden = true;
    } else {
      titulo.textContent = 'Acceso al sistema';
      subtitulo.textContent = 'Ingresa tus credenciales para continuar';
      config.hidden = true;
      inputPass.value = '';
    }

    limpiarErrores(formMfa);
    inputCodigo.value = '';
    (esMfa ? inputCodigo : document.getElementById('correo')).focus();
  }

  /* ---------- Paso 1 ---------- */
  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = window.Validacion.validarLogin({
      correo: formLogin.elements.correo.value,
      contrasena: formLogin.elements.contrasena.value
    });
    if (!v.ok) return mostrarErrores(formLogin, v.errores);

    limpiarErrores(formLogin);
    textoBoton(btnLogin, 'Verificando…', true);
    const r = await api('POST', '/api/auth/login', v.datos);
    textoBoton(btnLogin, 'Iniciar sesión', false);

    if (!r.ok) {
      inputPass.value = '';
      return mostrarErrores(formLogin, r.datos.errores || {}, r.datos.mensaje);
    }
    mostrarPaso(r.datos.paso, r.datos);
  });

  /* ---------- Paso 2 ---------- */
  formMfa.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = window.Validacion.validarCodigo({ codigo: inputCodigo.value });
    if (!v.ok) return mostrarErrores(formMfa, v.errores);

    limpiarErrores(formMfa);
    textoBoton(btnMfa, 'Verificando…', true);
    const r = await api('POST', '/api/auth/mfa', v.datos);

    if (!r.ok) {
      textoBoton(btnMfa, 'Verificar y entrar', false);
      inputCodigo.value = '';
      // Si el tiempo terminó o la cuenta se bloqueó, regresar al paso 1
      if (r.estado === 401 && !r.datos.errores) {
        mostrarPaso('credenciales');
        return mostrarErrores(formLogin, {}, r.datos.mensaje);
      }
      if (r.estado === 423) {
        mostrarPaso('credenciales');
        return mostrarErrores(formLogin, {}, r.datos.mensaje);
      }
      return mostrarErrores(formMfa, r.datos.errores || {}, r.datos.mensaje);
    }
    textoBoton(btnMfa, '¡Listo! Entrando…', true);
    if (r.datos.avisoContrasena) {
      // [OWASP A07] Se muestra en la siguiente pantalla
      try {
        sessionStorage.setItem('rs_aviso', 'Tu contraseña ya no cumple las reglas de seguridad (es corta o muy común). ' +
          'Cámbiala en Mi perfil → Seguridad.');
      } catch { /* sin almacenamiento */ }
    }
    window.location.href = r.datos.destino;
  });

  document.getElementById('btnVolver').addEventListener('click', () => mostrarPaso('credenciales'));
})();
