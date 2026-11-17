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

  // Si ya hay sesión, ir directo al panel
  api('GET', '/api/auth/sesion').then((r) => {
    if (r.ok && r.datos.usuario) {
      window.location.href = r.datos.usuario.nivel === 'Administrador' ? '/admin' : '/perfil';
    }
  });

  btnVer.addEventListener('click', () => {
    const visible = inputPass.type === 'text';
    inputPass.type = visible ? 'password' : 'text';
    btnVer.classList.toggle('activo', !visible);
    btnVer.setAttribute('aria-label', visible ? 'Mostrar contraseña' : 'Ocultar contraseña');
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
    window.location.href = r.datos.destino;
  });

  document.getElementById('btnVolver').addEventListener('click', () => mostrarPaso('credenciales'));
})();
