document.addEventListener('DOMContentLoaded', () => {
    // ==========================================
    // STATE VARIABLES & DYNAMIC WALLPAPER LOAD
    // ==========================================
    let currentUser = null;    // { id_cajero/id_admin, nombre, rol, id_barra, etc }
    let currentWaiter = null;  // { id_mesero, nombre }
    let categories = [];       // List of product categories
    let products = [];         // List of products
    // Paquetes de productos a precio cerrado. No son productos: no tienen
    // stock propio, y lo que sale de la nevera al venderlos es su contenido.
    let promociones = [];
    let cart = [];             // Cart items: { id_producto, nombre, precio_venta, cantidad, stock_max }
    let payments = [];         // Payment pills: { id_metodo_pago, nombre_metodo, monto, referencia }
    let activeCategory = null; // Filter categories (defaults to first sorted category)

    // System view elements
    const loginView = document.getElementById('login-view');
    const posView = document.getElementById('pos-view');
    const adminView = document.getElementById('admin-view');
    const waiterModal = document.getElementById('waiter-lock-modal');
    const voidModal = document.getElementById('void-confirm-modal');

    // Forms
    const loginForm = document.getElementById('login-form');
    const voidForm = document.getElementById('void-order-form');

    // Errors
    const loginError = document.getElementById('login-error');
    const waiterError = document.getElementById('waiter-error');

    // ==========================================
    // IDENTIDAD DE LA BARRA
    // ==========================================
    // La tablet pregunta al arrancar cómo se llama la barra, para rotularla en
    // pantalla y en los tickets. El nombre lo pone el encargado en el panel y
    // suele cambiar de un evento a otro.
    let instancia = { nombre: '' };

    // El número de comanda es sólo el número: es lo que el mesero canta en voz
    // alta y lo que el cliente busca en su ticket.
    const refComanda = id => String(id);

    function actualizarTituloBarra() {
        const titleEl = document.getElementById('pos-event-title');
        if (!titleEl) return;
        const nombre = (currentUser && currentUser.nombre_barra) ||
                       (configEvento && configEvento.barra) ||
                       (instancia && instancia.nombre) ||
                       '';
        if (nombre) {
            titleEl.textContent = nombre;
        }
    }

    async function cargarInstancia() {
        try {
            const res = await fetch('/api/instancia');
            if (!res.ok) return;
            instancia = await res.json();

            document.querySelectorAll('.instancia-badge').forEach(el => {
                el.textContent = instancia.nombre;
                el.classList.remove('hide');
            });

            actualizarTituloBarra();

            // El título nombra el acceso directo cuando se hace "Añadir a
            // pantalla de inicio", y de paso rotula la pestaña del navegador
            // con la barra y el evento que se están atendiendo.
            document.title = 'MasterDrinks · ' + instancia.nombre;

            // Si el número que sale aquí no coincide con el que imprimió el
            // servidor al arrancar, esta tablet está corriendo código viejo de
            // su caché: hay que recargar la página.
            if (instancia.version) {
                let v = String(instancia.version).trim();
                // Si viene en el formato numérico previo DDMM-HHmm (ej. "0709-1354")
                const m = v.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
                if (m) {
                    const dia = m[1];
                    const mes = m[2];
                    const hora = m[3];
                    const min = m[4];
                    const anio = new Date().getFullYear();
                    v = `${dia}/${mes}/${anio} - ${hora}:${min}`;
                }
                document.querySelectorAll('.version-num').forEach(el => {
                    el.textContent = v;
                });
            }
        } catch (err) {
            // Sin identidad la caja sigue funcionando: se cae al '#47' de antes.
            console.warn('No se pudo leer la identidad de la instancia:', err);
        }
    }

    cargarInstancia();
    // Los datos del evento y su afiche se piden al arrancar: la pantalla de
    // clave de mesero los enseña, y esa sale antes de la primera venta.
    cargarConfiguracion().then(pintarFichaEvento);
    cargarAfiche();

    // El nombre de la barra puede cambiar a mitad de evento, y lo cambia UNA
    // tablet: la del encargado. Las demás ya llevan horas abiertas y nadie las
    // va a tocar, están cobrando.
    //
    // Antes esto se leía sólo aquí, al abrir la página. Una tablet abierta por
    // la mañana seguía rotulando la barra vieja el resto de la noche, en la
    // pantalla y en lo que imprimía, sin que nadie sospechara nada.
    async function revisarIdentidad() {
        await cargarInstancia();
        await cargarConfiguracion();
        pintarFichaEvento();
    }

    // Volver a la tablet es justo el momento en que el cajero mira el rótulo,
    // así que se comprueba en ese gesto y no se espera al turno del reloj.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            revisarIdentidad();
            setTimeout(asegurarPantallaCompleta, 120);
        }
    });

    // Y por si la tablet se queda encendida toda la noche sin que nadie la
    // toque. Son dos campos de texto: pesa mucho menos que el sondeo de stock,
    // que va cada doce segundos.
    const INTERVALO_IDENTIDAD = 60000;
    setInterval(() => {
        // Con la pantalla apagada no hay nadie mirando: ya se mira al volver.
        if (document.hidden) return;
        revisarIdentidad();
    }, INTERVALO_IDENTIDAD);

    // ==========================================
    // AVISOS FLOTANTES
    // ==========================================
    // Reemplazan a alert(): en la tablet aquél abre un diálogo del sistema que
    // hay que cerrar a mano, y con la barra llena eso cuesta ventas. Estos se
    // apilan arriba a la derecha y se van solos; los de error aguantan más
    // tiempo porque suelen exigir que el cajero haga algo.
    const TOAST_ICONOS = { ok: '✓', error: '✕', warn: '!', info: 'i' };

    function notify(mensaje, tipo = 'info', ms) {
        const pila = document.getElementById('toast-stack');
        if (!pila) return;

        const toast = document.createElement('div');
        toast.className = 'toast toast-' + tipo;
        toast.innerHTML =
            '<span class="toast-icon">' + (TOAST_ICONOS[tipo] || 'i') + '</span>' +
            '<span class="toast-text"></span>';
        toast.querySelector('.toast-text').textContent = mensaje;

        // Al tocarlo se va: si se apilan varios, el cajero puede despejarlos.
        toast.addEventListener('click', () => cerrarToast(toast));
        pila.appendChild(toast);

        setTimeout(() => cerrarToast(toast), ms || (tipo === 'error' ? 6000 : 3200));
    }

    function cerrarToast(toast) {
        if (!toast.isConnected || toast.classList.contains('toast-out')) return;
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 220);
    }
    window.notify = notify;

    // Modal de confirmación elegante en la app (sustituye a window.confirm / localhost dice...)
    function pedirConfirmacion({
        titulo = '¿Estás seguro?',
        mensaje = 'Esta acción no se puede deshacer.',
        detalle = null,
        textoAceptar = 'Eliminar',
        textoCancelar = 'Cancelar',
        tipo = 'peligro', // 'peligro' | 'aviso' | 'info'
        icono = null
    } = {}) {
        return new Promise(resolve => {
            const modal = document.getElementById('confirm-modal');
            if (!modal) {
                resolve(window.confirm(mensaje + (detalle ? '\n\n' + detalle : '')));
                return;
            }

            const elTitulo = document.getElementById('confirm-modal-titulo');
            const elMensaje = document.getElementById('confirm-modal-mensaje');
            const elNotaBox = document.getElementById('confirm-modal-nota-box');
            const elNota = document.getElementById('confirm-modal-nota');
            const elIcono = document.getElementById('confirm-modal-icono');
            const elBadge = document.getElementById('confirm-modal-badge');
            const btnAceptar = document.getElementById('confirm-modal-btn-aceptar');
            const btnCancelar = document.getElementById('confirm-modal-btn-cancelar');
            const btnCerrar = document.getElementById('confirm-modal-cerrar');

            if (elTitulo) elTitulo.textContent = titulo;
            if (elMensaje) elMensaje.textContent = mensaje;

            if (elNota && elNotaBox) {
                if (detalle) {
                    elNota.textContent = detalle;
                    elNotaBox.classList.remove('hide');
                } else {
                    elNotaBox.classList.add('hide');
                }
            }

            const iconosDef = { peligro: '🗑️', aviso: '⚠️', info: 'ℹ️' };
            if (elIcono) elIcono.textContent = icono || iconosDef[tipo] || '⚠️';
            if (elBadge) elBadge.className = 'confirm-modal-badge tipo-' + tipo;
            if (btnAceptar) {
                btnAceptar.className = 'btn-confirm-aceptar tipo-' + tipo;
                btnAceptar.textContent = textoAceptar;
            }
            if (btnCancelar) btnCancelar.textContent = textoCancelar;

            function limpiar() {
                modal.classList.add('hide');
                btnAceptar.removeEventListener('click', onAceptar);
                btnCancelar.removeEventListener('click', onCancelar);
                btnCerrar.removeEventListener('click', onCancelar);
                modal.removeEventListener('click', onBackdrop);
                window.removeEventListener('keydown', onKey);
            }

            function onAceptar() {
                limpiar();
                resolve(true);
            }

            function onCancelar() {
                limpiar();
                resolve(false);
            }

            function onBackdrop(e) {
                if (e.target === modal) onCancelar();
            }

            function onKey(e) {
                if (e.key === 'Escape') onCancelar();
            }

            btnAceptar.addEventListener('click', onAceptar);
            btnCancelar.addEventListener('click', onCancelar);
            btnCerrar.addEventListener('click', onCancelar);
            modal.addEventListener('click', onBackdrop);
            window.addEventListener('keydown', onKey);

            modal.classList.remove('hide');
            btnAceptar.focus();
        });
    }
    window.pedirConfirmacion = pedirConfirmacion;

    // Dynamic wallpaper color extractor
    /**
     * Carga el fondo de pantalla. Nada más.
     *
     * Antes esto analizaba el color dominante de la imagen y reescribía la
     * paleta entera (--primary, --gradient-primary, las sombras). Con un
     * fondo oscuro y poco saturado —como el que hay— caía en la rama
     * "blanco/gris" y dejaba el degradado principal en blanco → gris: los
     * botones de "Iniciar Sesión" y "CONFIRMAR PAGO" salían blancos sobre
     * blanco, con pinta de estar desactivados, y el total del cobro casi no se
     * leía. La identidad de la marca la define el CSS, no la foto del fondo.
     */
    function cargarFondo() {
        const img = new Image();
        img.src = 'Wallpaper.jpg';
        img.onerror = () => {
            if (img.src.endsWith('Wallpaper.jpg')) img.src = 'wallpaper.jpg';
        };
        img.onload = () => {
            document.body.style.setProperty('--wallpaper-url', `url('${img.src}')`);
            document.body.classList.add('con-fondo');
        };
    }

    // Initialize wallpaper styling
    cargarFondo();

    // ==========================================
    // 1. ROUTING & LOGIN CONTROLLER
    // ==========================================
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.classList.add('hide');

        const usuario = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ usuario, password })
            });
            const data = await response.json();

            if (data.success) {
                currentUser = data.user;
                currentUser.rol = data.rol;

                // Reset forms
                loginForm.reset();
                setTimeout(asegurarPantallaCompleta, 100);

                if (data.rol === 'CAJERO') {
                    // Show waiter security modal
                    showWaiterModal();
                } else if (data.rol === 'ADMINISTRADOR' || data.rol === 'SUPERVISOR' || data.rol === 'ENCARGADO' || data.rol === 'ENCARGADO_STOCK' || data.rol === 'ENCARGADO_INVENTARIO' || data.rol === 'ENCARGA') {
                    // Show admin / inventory dashboard
                    showAdminView();
                }
            } else {
                showError(loginError, data.message || 'Credenciales incorrectas');
            }
        } catch (err) {
            showError(loginError, 'Error al conectar con el servidor.');
        }
    });

    // PIN pad state and logic
    let waiterPin = '';

    function updatePinDots() {
        const dots = document.querySelectorAll('#pin-dots .dot');
        dots.forEach((dot, idx) => {
            if (idx < waiterPin.length) {
                dot.classList.add('filled');
            } else {
                dot.classList.remove('filled');
            }
        });

        // "Ingresar" se enciende sólo con las cuatro cifras puestas. Es la
        // única señal de que ya no falta nada por teclear, y se ve sin leer.
        const botonEntrar = document.getElementById('pin-enter');
        if (botonEntrar) botonEntrar.classList.toggle('completo', waiterPin.length === 4);
    }

    function clearPin() {
        waiterPin = '';
        updatePinDots();
    }

    async function handlePinInput(char) {
        if (waiterPin.length >= 4) return;
        waiterPin += char;
        updatePinDots();
        // Un golpecito por cifra. En una tablet sin teclado es la única
        // confirmación de que el toque entró: sin él, el mesero que no ve
        // bien los puntos vuelve a pulsar y mete la cifra dos veces.
        vibrar(12);
        
        if (waiterPin.length === 4) {
            await verifyWaiterPin(waiterPin);
        }
    }

    function handlePinBackspace() {
        if (waiterPin.length === 0) return;
        waiterPin = waiterPin.slice(0, -1);
        updatePinDots();
    }

    const meseroPinCache = new Map();

    async function verifyWaiterPin(pin) {
        waiterError.classList.add('hide');

        if (meseroPinCache.has(pin)) {
            currentWaiter = meseroPinCache.get(pin);
            clearPin();
            waiterModal.classList.add('hide');
            await showPOSView();
            return;
        }
        
        try {
            const response = await fetch('/api/login/mesero', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // El PIN se valida contra los meseros de esta barra, no contra los
                // de todo el evento: todas las tablets conectadas son de la misma barra.
                body: JSON.stringify({
                    password: pin,
                    id_cajero: currentUser ? currentUser.id_cajero : null,
                    id_barra: currentUser ? currentUser.id_barra : null,
                    id_evento: currentUser ? currentUser.id_evento : null
                })
            });
            const data = await response.json();

            if (data.success) {
                currentWaiter = data.mesero;
                meseroPinCache.set(pin, data.mesero);
                clearPin();
                waiterModal.classList.add('hide');
                await showPOSView();
            } else {
                // Shake visual dots on verification error
                const dotsContainer = document.getElementById('pin-dots');
                dotsContainer.classList.add('shake');
                vibrar([40, 60, 40]);
                showError(waiterError, data.message || 'PIN incorrecto');
                
                setTimeout(() => {
                    dotsContainer.classList.remove('shake');
                    clearPin();
                }, 400);
            }
        } catch (err) {
            showError(waiterError, 'Error de conexión.');
            clearPin();
        }
    }

    // Keypad listeners
    document.querySelectorAll('.pin-btn[data-key]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-key');
            handlePinInput(key);
        });
    });

    // El botón "Ingresar" de la propuesta.
    //
    // La clave se sigue mandando sola al teclear la cuarta cifra: con cola en
    // la barra, un toque de más por comanda son minutos por noche. Así que
    // este botón no es el único camino, es el que busca quien no sabe que no
    // hace falta; hace lo mismo, y si faltan cifras lo dice en vez de quedarse
    // quieto, que es lo que hace un botón que parece roto.
    function intentarEntrar() {
        if (waiterPin.length < 4) {
            showError(waiterError, 'La clave tiene cuatro cifras.');
            return;
        }
        verifyWaiterPin(waiterPin);
    }

    document.getElementById('pin-enter').addEventListener('click', intentarEntrar);

    // Borrar: un toque quita una cifra; mantener pulsado las quita todas. La
    // tecla "C" que hacía esto último ya no está en el teclado —ocupaba un
    // sitio para algo que se usa una vez de cada cien—, pero el borrado
    // entero sigue haciendo falta cuando el mesero pierde la cuenta.
    const teclaBorrar = document.getElementById('pin-back');
    const ESPERA_BORRADO = 550;
    let temporizadorBorrado = null;
    let borradoEntero = false;

    teclaBorrar.addEventListener('pointerdown', () => {
        borradoEntero = false;
        temporizadorBorrado = setTimeout(() => {
            temporizadorBorrado = null;
            borradoEntero = true;
            if (waiterPin) vibrar(25);
            clearPin();
        }, ESPERA_BORRADO);
    });

    // 'pointerleave' y 'pointercancel' además de 'pointerup': en la tablet el
    // dedo se desliza fuera de la tecla sin llegar a levantarse.
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => {
        teclaBorrar.addEventListener(ev, () => {
            if (temporizadorBorrado) clearTimeout(temporizadorBorrado);
            temporizadorBorrado = null;
        });
    });

    teclaBorrar.addEventListener('click', () => {
        // Al soltar después de una pulsación larga llega también el click. Si
        // no se descarta, borra una cifra de la clave siguiente.
        if (borradoEntero) {
            borradoEntero = false;
            return;
        }
        handlePinBackspace();
    });

    // Keyboard bindings for the PIN screen
    window.addEventListener('keydown', (e) => {
        // Ya no hace falta comprobar la vista previa: no existe. El teclado
        // físico escribe el PIN siempre que esa pantalla sea la que manda.
        const isWaiterModalActive = !waiterModal.classList.contains('hide') &&
                                    loginView.classList.contains('hide');
        if (isWaiterModalActive) {
            if (e.key >= '0' && e.key <= '9') {
                handlePinInput(e.key);
            } else if (e.key === 'Backspace') {
                handlePinBackspace();
            } else if (e.key === 'Escape' || e.key === 'Delete') {
                clearPin();
            } else if (e.key === 'Enter') {
                intentarEntrar();
            }
        }
    });

    // Deja el POS como recién abierto.
    //
    // Sin esto, el mesero que armaba un pedido y se iba sin cobrar se lo dejaba
    // puesto al siguiente: entraba con su PIN y se encontraba el carrito de
    // otro, con el contador marcando productos que él no había tocado. Si lo
    // cobraba sin mirar, la venta salía mal y el stock también.
    function vaciarCarrito() {
        const habia = cart.length;
        const tocados = cart.map(i => i.id_producto);

        cart = [];
        payments = [];
        efectivoRecibido = 0;
        metodoActivo = EFECTIVO;

        const obs = document.getElementById('cart-observations');
        if (obs) obs.value = '';

        renderCart();
        recalcularTotal();
        // Las tarjetas llevan encima el número de unidades ya añadidas: hay que
        // quitárselo, o seguirían marcando un carrito que ya no existe.
        tocados.forEach(id => actualizarTarjeta(id, false));
        return habia;
    }

    // Salida al login, escondida detrás de una pulsación larga.
    //
    // El botón visible que había aquí se quitó: la barra es siempre la misma y
    // el cajero no cambia durante el turno, así que sólo servía para salirse
    // sin querer y tener que volver a teclear usuario y contraseña con gente
    // esperando. Pero el encargado sí necesita llegar al panel para ajustar
    // stock o sacar el cierre, y sin ninguna salida habría que recargar la
    // página en el navegador, que en una tablet no es evidente.
    //
    // Tres segundos: lo bastante largo como para que nadie lo descubra por
    // accidente apoyando el dedo, lo bastante corto para no desesperar.
    const ESPERA_SALIDA = 3000;
    let temporizadorSalida = null;

    function cerrarSesionCajero() {
        vaciarCarrito();
        currentUser = null;
        currentWaiter = null;
        clearPin();
        waiterModal.classList.add('hide');
        posView.classList.add('hide');
        loginView.classList.remove('hide');
    }
    window.cerrarSesionCajero = cerrarSesionCajero;

    const salidaOculta = document.getElementById('salida-oculta');
    if (salidaOculta) {
        const empezar = () => {
            cancelar();
            salidaOculta.classList.add('cargando');
            temporizadorSalida = setTimeout(() => {
                salidaOculta.classList.remove('cargando');
                vibrar([30, 60, 30]);
                notify('Sesión del cajero cerrada.', 'ok');
                cerrarSesionCajero();
            }, ESPERA_SALIDA);
        };
        const cancelar = () => {
            salidaOculta.classList.remove('cargando');
            if (temporizadorSalida) clearTimeout(temporizadorSalida);
            temporizadorSalida = null;
        };

        // pointer* cubre dedo y ratón con los mismos manejadores. 'pointerleave'
        // y 'pointercancel' hacen falta porque en una tablet el dedo se desliza
        // fuera del icono sin llegar a levantarse.
        salidaOculta.addEventListener('pointerdown', empezar);
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(
            ev => salidaOculta.addEventListener(ev, cancelar));
    }

    // Lock POS (Switch waiter)
    document.getElementById('lock-pos-btn').addEventListener('click', () => {
        // Se avisa de lo que se descarta: si el mesero se equivocó de botón,
        // tiene que enterarse ahora y no cuando vuelva y no encuentre nada.
        const habia = vaciarCarrito();
        if (habia > 0) {
            notify('Se vació el carrito: ' + habia +
                   (habia === 1 ? ' producto sin cobrar.' : ' productos sin cobrar.'), 'warn');
        }
        currentWaiter = null;
        posView.classList.add('hide');
        showWaiterModal();
    });

    // Logout from Admin Panel
    document.getElementById('admin-logout-btn').addEventListener('click', () => {
        currentUser = null;
        adminView.classList.add('hide');
        loginView.classList.remove('hide');
    });

    function showWaiterModal() {
        loginView.classList.add('hide');
        posView.classList.add('hide');
        adminView.classList.add('hide');
        // Caja bloqueada: nadie está vendiendo, no hace falta vigilar el stock.
        detenerSondeoStock();
        
        // El cajero de turno es uno de los cuatro sellos de la ficha, así que
        // se repinta entera en vez de tocar sólo ese hueco.
        pintarFichaEvento();
        clearPin();
        waiterModal.classList.remove('hide');
        // Ahora que la pantalla está a la vista, el hueco del cartel ya mide
        // algo y se puede decidir si la imagen da la talla.
        ajustarCalidadDelAfiche();
    }

    // ==========================================
    // 2. POS PORTAL (ORDERING SYSTEM)
    // ==========================================
    async function showPOSView() {
        loginView.classList.add('hide');
        adminView.classList.add('hide');
        posView.classList.remove('hide');

        // Setup headers
        actualizarTituloBarra();
        const barraName = (currentUser && currentUser.nombre_barra) || (configEvento && configEvento.barra) || (instancia && instancia.nombre) || 'Barra';
        document.getElementById('pos-barra-name').textContent = barraName;
        document.getElementById('pos-cajero-label').textContent = currentUser ? currentUser.nombre : '';
        document.getElementById('pos-mesero-label').textContent = currentWaiter ? currentWaiter.nombre : '';
        const chipName = document.getElementById('pos-user-chip-name');
        if (chipName) {
            chipName.textContent = currentWaiter ? currentWaiter.nombre : (currentUser ? currentUser.nombre : '');
        }

        // Fetch menu
        await fetchProductsAndMenu();
        
        // Reset states
        cart = [];
        payments = [];
        efectivoRecibido = 0;
        document.getElementById('cart-observations').value = '';
        renderCart();

        // Recalcular tamaño exacto de botones de categorías al mostrar la vista
        recalcularBotonesCategorias();
        if (typeof window !== 'undefined' && window.requestAnimationFrame) {
            window.requestAnimationFrame(recalcularBotonesCategorias);
        }
        setTimeout(recalcularBotonesCategorias, 50);
        setTimeout(recalcularBotonesCategorias, 200);

        // Mientras haya caja abierta, las existencias se vigilan solas.
        iniciarSondeoStock();
    }

    async function fetchProductsAndMenu() {
        renderSkeleton();
        try {
            const response = await fetch('/api/productos');
            const data = await response.json();
            categories = data.categorias;
            const catsOrdenadas = ordenarCategorias(categories);
            const catRank = new Map(catsOrdenadas.map((c, i) => [c.id_categoria, i]));
            products = (data.productos || []).sort((a, b) => {
                const rankA = catRank.has(a.id_categoria) ? catRank.get(a.id_categoria) : 999;
                const rankB = catRank.has(b.id_categoria) ? catRank.get(b.id_categoria) : 999;
                if (rankA !== rankB) return rankA - rankB;
                const ordA = Number(a.orden != null ? a.orden : 0);
                const ordB = Number(b.orden != null ? b.orden : 0);
                if (ordA !== ordB) return ordA - ordB;
                return (a.id_producto || 0) - (b.id_producto || 0);
            });
            promociones = data.promociones || [];

            renderCategories();
            animarRejilla = true;   // única vez que la rejilla entra en cascada
            renderProducts();
        } catch (err) {
            console.error("Error fetching menu:", err);
            notify('No se pudo cargar el catálogo. Revisa la conexión.', 'error');
        }
    }

    // ==========================================
    // STOCK COMPARTIDO ENTRE TABLETS
    // ==========================================
    // Varias tablets venden contra el mismo servidor, así que las existencias
    // cambian por debajo de esta pantalla sin que esta tablet haga nada. Se
    // vuelven a leer cada pocos segundos.
    //
    // Se eligió preguntar cada X segundos en vez de que el servidor empuje los
    // cambios (SSE o WebSocket) por el sitio donde va a funcionar: en un evento
    // hay mucha interferencia y una conexión abierta se corta a cada rato. Cada
    // consulta es independiente, así que un corte no deja nada colgado: la
    // siguiente vuelve a cuadrar sola. Son dos SELECT, no pesa nada.
    const INTERVALO_STOCK = 5000;
    let temporizadorStock = null;

    function iniciarSondeoStock() {
        detenerSondeoStock();
        temporizadorStock = setInterval(() => {
            if (document.hidden) return;
            if (posView && posView.classList.contains('hide')) return;
            refrescarStock();
        }, INTERVALO_STOCK);
    }

    function detenerSondeoStock() {
        if (temporizadorStock) clearInterval(temporizadorStock);
        temporizadorStock = null;
    }

    // Al volver a la app se refresca silenciosamente
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && posView && !posView.classList.contains('hide')) {
            refrescarStock();
        }
    });

    /**
     * Sincronización silenciosa e invisible de existencias:
     * Actualiza directamente los números y el sello de agotado sobre las tarjetas
     * sin repintar la rejilla, sin animaciones de carga y sin mover el scroll.
     */
    async function refrescarStock() {
        if (!products || products.length === 0) return;
        let data;
        try {
            const response = await fetch('/api/stock');
            if (!response.ok) return;
            data = await response.json();
        } catch (err) {
            return;
        }

        if (!data || !Array.isArray(data.stock)) return;
        const llegado = new Map(data.stock.map(p => [p.id, p.s]));

        let algunCambio = false;
        products.forEach(p => {
            const nuevo = llegado.get(p.id_producto);
            if (nuevo !== undefined && nuevo !== p.stock_actual) {
                p.stock_actual = nuevo;
                actualizarTarjeta(p.id_producto, false);
                algunCambio = true;
            }
        });

        if (algunCambio && cart.length > 0) {
            avisarSiFaltaStock();
        }
    }

    /**
     * Avisa cuando otra tablet se ha llevado algo que este carrito ya tenía.
     * Enterarse aquí es incómodo; enterarse al cobrar, con el cliente delante y
     * el pedido tomado, es peor.
     */
    function avisarSiFaltaStock() {
        if (cart.length === 0) return;

        const problemas = [];
        let habiaPaquete = false;

        // Copia de la lista: dentro se quitan líneas, y recorrer la misma que
        // se está modificando salta elementos.
        [...cart].forEach(item => {
            // Un paquete no tiene stock propio, así que la pregunta no es
            // "¿quedan?" sino "¿siguen quedando todos los que lleva dentro?".
            // Sin esto se le buscaba un id_producto que no tiene, salía cero, y
            // el sondeo borraba el combo del carrito cada doce segundos sin que
            // nadie tocara nada.
            if (item.tipo === 'promo') {
                habiaPaquete = true;
                const caben = paquetesQueCaben(item, item);
                if (item.cantidad <= caben) return;
                problemas.push({ item, disponible: caben });
                if (caben <= 0) cart = cart.filter(c => c !== item);
                else item.cantidad = caben;
                return;
            }

            const enCatalogo = products.find(p => p.id_producto === item.id_producto);
            const disponible = enCatalogo ? enCatalogo.stock_actual : 0;
            if (item.cantidad <= disponible) return;

            problemas.push({ item, disponible });
            // Se ajusta el carrito a lo que queda de verdad: dejarlo pidiendo
            // lo que no existe solo aplaza el rechazo hasta el cobro.
            if (disponible <= 0) {
                cart = cart.filter(c => c.id_producto !== item.id_producto);
            } else {
                item.cantidad = disponible;
            }
        });

        if (problemas.length === 0) return;

        renderCart();
        recalcularTotal();
        // Si se tocó un paquete hay que repintar la rejilla entera: sus
        // productos están repartidos por toda la lista y no hay una sola
        // tarjeta que actualizar.
        if (habiaPaquete) renderProducts();
        problemas.forEach(p => {
            if (p.item.tipo === 'promo') {
                // El paquete tiene su propio mensaje: decir "solo quedan 2"
                // de un combo confundiría, porque lo que se acabó no es el
                // combo sino alguna de las bebidas que lleva dentro.
                notify(p.disponible <= 0
                    ? `Otra caja vendió lo que llevaba "${p.item.nombre}": se quitó del carrito.`
                    : `Ya solo quedan existencias para ${p.disponible} de "${p.item.nombre}": se ajustó el carrito.`,
                    'warn', 7000);
                return;
            }
            actualizarTarjeta(p.item.id_producto);
            notify(p.disponible <= 0
                ? `Otra caja vendió el último ${p.item.nombre}: se quitó del carrito.`
                : `Solo quedan ${p.disponible} de ${p.item.nombre}: se ajustó el carrito.`,
                'warn', 7000);
        });
    }

    function ordenarCategorias(lista) {
        return [...lista].sort((a, b) => {
            const ordA = Number(a.orden != null ? a.orden : 0);
            const ordB = Number(b.orden != null ? b.orden : 0);
            if (ordA !== ordB) return ordA - ordB;
            return (a.id_categoria || 0) - (b.id_categoria || 0);
        });
    }

    function iconoCategoria(nombre, tipo) {
        const n = (nombre || '').toLowerCase().trim();
        if (n.startsWith('botella')) return '🍾';
        if (n.startsWith('soda')) return '🥤';
        if (n.startsWith('cerveza')) return '🍺';
        if (n.startsWith('agua')) return '💧';
        if (n.startsWith('comida')) return '🍔';
        if (tipo === 'COMIDA') return '🍔';
        if (tipo === 'BEBIDA') return '🍹';
        return '📦';
    }

    function renderCategories() {
        const catList = document.getElementById('category-list');
        catList.innerHTML = '';

        const catsOrdenadas = ordenarCategorias(categories);

        // Si la categoría activa es nula o inválida, seleccionar la primera por defecto
        const categoriaValida = catsOrdenadas.some(c => c.id_categoria === activeCategory) || activeCategory === 'promociones';
        if (!categoriaValida) {
            if (catsOrdenadas.length > 0) {
                activeCategory = catsOrdenadas[0].id_categoria;
            } else {
                activeCategory = 'promociones';
            }
        }

        // 1. Renderizar categorías (sin el botón "TODOS")
        catsOrdenadas.forEach(cat => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `category-btn ${activeCategory === cat.id_categoria ? 'active' : ''}`;
            btn.textContent = `${iconoCategoria(cat.nombre, cat.tipo)} ${cat.nombre}`;
            btn.addEventListener('click', () => {
                activeCategory = cat.id_categoria;
                document.querySelectorAll('#category-list .category-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderProducts();
            });
            catList.appendChild(btn);
        });

        // 2. Promociones al final
        const promoBtn = document.createElement('button');
        promoBtn.type = 'button';
        promoBtn.className = `category-btn ${activeCategory === 'promociones' ? 'active' : ''}`;
        promoBtn.textContent = '🏷️ Promociones';
        promoBtn.addEventListener('click', () => {
            activeCategory = 'promociones';
            document.querySelectorAll('#category-list .category-btn').forEach(b => b.classList.remove('active'));
            promoBtn.classList.add('active');
            renderProducts();
        });
        catList.appendChild(promoBtn);
        recalcularBotonesCategorias();
        if (typeof window !== 'undefined' && window.requestAnimationFrame) {
            window.requestAnimationFrame(recalcularBotonesCategorias);
        }
    }

    function recalcularBotonesCategorias() {
        const catList = document.getElementById('category-list');
        if (!catList) return;
        const buttons = catList.querySelectorAll('.category-btn');
        const n = buttons.length;
        if (n === 0) return;

        const availableWidth = catList.clientWidth;
        if (availableWidth <= 0) return;

        // Gap dinámico según ancho disponible y cantidad de botones
        let gap = 6;
        if (availableWidth < 650 || n >= 8) gap = 3;
        else if (availableWidth < 900 || n >= 7) gap = 4;
        else if (availableWidth < 1200) gap = 6;
        else gap = 8;

        const widthPerBtn = (availableWidth - (gap * (n - 1))) / n;

        // Cálculo de tamaño de fuente, padding y espaciado de letras
        let fontSize = 0.88;
        let padX = 10;
        let padY = 8;
        let letterSpacing = '-0.2px';

        if (widthPerBtn < 75) {
            fontSize = 0.62;
            padX = 3;
            padY = 6;
            letterSpacing = '-0.5px';
        } else if (widthPerBtn < 90) {
            fontSize = 0.68;
            padX = 4;
            padY = 7;
            letterSpacing = '-0.4px';
        } else if (widthPerBtn < 110) {
            fontSize = 0.74;
            padX = 5;
            padY = 7;
            letterSpacing = '-0.3px';
        } else if (widthPerBtn < 130) {
            fontSize = 0.79;
            padX = 7;
            padY = 8;
            letterSpacing = '-0.25px';
        }

        catList.style.setProperty('--cat-gap', `${gap}px`);
        catList.style.setProperty('--cat-pad-y', `${padY}px`);
        catList.style.setProperty('--cat-pad-x', `${padX}px`);
        catList.style.setProperty('--cat-font-size', `${fontSize}rem`);
        catList.style.setProperty('--cat-letter-spacing', letterSpacing);

        // Verificación y ajuste fino: si algún botón o el total sigue desbordando,
        // reducir progresivamente la fuente y el padding para garantizar que NINGÚN botón se corte
        let tries = 0;
        while (tries < 10) {
            let hasOverflow = false;
            for (const btn of buttons) {
                if (btn.scrollWidth > btn.clientWidth + 0.5) {
                    hasOverflow = true;
                    break;
                }
            }
            if (!hasOverflow || (fontSize <= 0.54 && padX <= 2)) break;
            if (fontSize > 0.54) fontSize -= 0.025;
            if (padX > 2) padX -= 1;
            if (gap > 2) gap -= 1;
            catList.style.setProperty('--cat-gap', `${gap}px`);
            catList.style.setProperty('--cat-font-size', `${fontSize.toFixed(3)}rem`);
            catList.style.setProperty('--cat-pad-x', `${padX}px`);
            tries++;
        }
    }

    // Muestra la rejilla con forma de tarjetas mientras llega el catálogo, para
    // que al aparecer los productos no salte todo de sitio.
    function renderSkeleton(cuantas = 8) {
        const grid = document.getElementById('product-grid');
        grid.innerHTML = '';
        for (let i = 0; i < cuantas; i++) {
            const hueco = document.createElement('div');
            hueco.className = 'skeleton-card';
            grid.appendChild(hueco);
        }
    }

    const emojiDe = p => {
        if (p.tipo_producto === 'BEBIDA_ALCOHOLICA') return '🍺';
        if (p.tipo_producto === 'BEBIDA_NO_ALCOHOLICA') return '🥤';
        if (p.tipo_producto === 'COMIDA') return '🍔';
        return '🍹';
    };

    // ------------------------------------------------------------------
    // LA BARRITA DE EXISTENCIAS
    // ------------------------------------------------------------------
    // Cruza la parte de arriba de cada tarjeta y dice de un vistazo cuánto
    // queda de ese producto, sin leer el número: llena y verde cuando hay de
    // sobra, ámbar a partir de la mitad y roja cuando está en las últimas.
    //
    // Se mide contra stock_tope —el nivel más alto que ese producto llegó a
    // tener, que calcula el servidor— y no contra un número fijo. Un umbral
    // igual para todos no dice nada: diez cervezas de doscientas es una barra
    // vacía y diez botellas de doce está casi llena.
    const NIVEL_MEDIO = 0.5;    // desde la mitad para abajo, ámbar
    const NIVEL_BAJO = 0.25;    // desde un cuarto para abajo, rojo

    function nivelDeStock(restante, tope) {
        // El techo nunca es cero ni menor que lo que queda: si lo fuera, la
        // división daría infinito o una barra por encima del 100 %.
        const techo = Math.max(tope || 0, restante, 1);
        const parte = Math.max(0, Math.min(1, restante / techo));

        return {
            ancho: (parte * 100).toFixed(1) + '%',
            clase: parte <= 0 ? 'vacio'
                 : parte <= NIVEL_BAJO ? 'bajo'
                 : parte <= NIVEL_MEDIO ? 'medio'
                 : 'alto'
        };
    }

    function pintarBarraStock(card, p, restante) {
        const barra = card.querySelector('.stock-barra');
        if (!barra) return;

        // Una reposición a mitad de noche deja el stock por encima del tope que
        // traía el catálogo. El tope sube con él, en vez de dejar la barra
        // clavada al 100 % hasta la siguiente recarga.
        if (p.stock_actual > (p.stock_tope || 0)) p.stock_tope = p.stock_actual;

        const nivel = nivelDeStock(restante, p.stock_tope);
        barra.className = 'stock-barra ' + nivel.clase;
        barra.firstElementChild.style.width = nivel.ancho;
    }

    /**
     * Refresca una sola tarjeta: stock restante y unidades ya en el carrito.
     * Antes cada toque reconstruía la rejilla entera —veinte tarjetas tiradas y
     * vueltas a crear—, y eso se ve como un parpadeo y pierde el desplazamiento.
     */
    function actualizarTarjeta(id_producto, conRebote) {
        const grid = document.getElementById('product-grid');
        const card = grid ? grid.querySelector(`.product-card[data-id="${id_producto}"]`) : null;
        if (card) {
            const p = products.find(x => x.id_producto === id_producto);
            if (p) {
                const unidades = unidadesEnCarrito(id_producto);
                const restante = p.stock_actual - unidades;
                const displayStock = Math.max(0, restante);
                const tope = p.stock_tope || p.stock_actual || 10;
                const pct = tope > 0 ? Math.min(100, Math.max(0, Math.round((displayStock / tope) * 100))) : (displayStock > 0 ? 100 : 0);
                const isOut = restante <= 0;
                const statusClass = isOut ? 'out' : (pct <= 40 ? 'low' : 'normal');
                const strokeColor = isOut ? '#e5e7eb' : (pct <= 40 ? '#ef4444' : '#facc15');

                card.classList.toggle('out-of-stock', isOut);

                const gaugeBar = card.querySelector('.gauge-bar');
                if (gaugeBar) {
                    const pathLen = 216.77;
                    const offset = pathLen * (1 - (isOut ? 0 : pct / 100));
                    gaugeBar.style.strokeDashoffset = offset;
                    gaugeBar.style.stroke = strokeColor;
                }

                const stamp = card.querySelector('.stamp-agotado');
                const foto = card.querySelector('.product-foto, .emoji');
                if (stamp) stamp.classList.toggle('hide', !isOut);
                if (foto) foto.classList.toggle('foto-agotada', isOut);

                const footer = card.querySelector('.stock-footer');
                if (footer) {
                    footer.className = `stock-footer ${statusClass}`;
                    const labelLine = footer.querySelector('.stock-label-line');
                    if (labelLine) labelLine.textContent = `Stock: ${pct}%`;
                    const unitsLine = footer.querySelector('.stock-units-line');
                    if (unitsLine) {
                        unitsLine.className = `stock-units-line stock ${isOut ? 'out' : ''}`;
                        unitsLine.innerHTML = isOut ? '0 UNIDADES<span class="sr-only"> (Agotado)</span>' : `${displayStock} UDS`;
                    }
                }

                let badge = card.querySelector('.cart-badge');
                if (unidades > 0) {
                    if (!badge) {
                        badge = document.createElement('span');
                        badge.className = 'cart-badge';
                        card.appendChild(badge);
                    }
                    badge.textContent = unidades;
                    if (conRebote) {
                        badge.classList.remove('bump');
                        void badge.offsetWidth;
                        badge.classList.add('bump');
                    }
                } else if (badge) {
                    badge.remove();
                }
            }
        }

        // Actualizar también las tarjetas de combos que incluyan este producto
        promociones.forEach(pr => {
            if ((pr.contenido || []).some(c => c.id_producto === id_producto)) {
                actualizarTarjetaPromo(pr.id_promocion, conRebote);
            }
        });
    }

    function actualizarTarjetaPromo(id_promocion, conRebote) {
        const grid = document.getElementById('product-grid');
        if (!grid) return;
        const card = grid.querySelector(`.product-card.promo-card[data-promo="${id_promocion}"]`);
        if (!card) return;

        const pr = promociones.find(x => x.id_promocion === id_promocion);
        if (!pr) return;

        const caben = paquetesQueCaben(pr);
        const puestos = (cart.find(c => c.tipo === 'promo' && c.id_promocion === pr.id_promocion) || {}).cantidad || 0;
        const restante = Math.max(0, caben - puestos);
        const isOut = caben <= 0 || restante <= 0;
        const pct = caben > 0 ? Math.min(100, Math.max(0, Math.round((caben / 10) * 100))) : 0;
        const statusClass = isOut ? 'out' : (pct <= 40 ? 'low' : 'normal');
        const strokeColor = isOut ? '#e5e7eb' : (pct <= 40 ? '#ef4444' : '#facc15');

        card.classList.toggle('out-of-stock', isOut);

        const gaugeBar = card.querySelector('.gauge-bar');
        if (gaugeBar) {
            const pathLen = 216.77;
            const offset = pathLen * (1 - (isOut ? 0 : pct / 100));
            gaugeBar.style.strokeDashoffset = offset;
            gaugeBar.style.stroke = strokeColor;
        }

        const stamp = card.querySelector('.stamp-agotado');
        const foto = card.querySelector('.product-foto, .promo-foto, .emoji');
        if (stamp) stamp.classList.toggle('hide', !isOut);
        if (foto) foto.classList.toggle('foto-agotada', isOut);

        const footer = card.querySelector('.stock-footer');
        if (footer) {
            footer.className = `stock-footer ${statusClass}`;
            const unitsLine = footer.querySelector('.stock-units-line');
            if (unitsLine) {
                unitsLine.className = `stock-units-line stock ${isOut ? 'out' : ''}`;
                unitsLine.innerHTML = isOut ? '0 COMBOS<span class="sr-only"> (Agotado)</span>' : `${caben} ${caben === 1 ? 'COMBO' : 'COMBOS'}`;
            }
        }

        let badge = card.querySelector('.cart-badge');
        if (puestos > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'cart-badge';
                card.appendChild(badge);
            }
            badge.textContent = puestos;
            if (conRebote) {
                badge.classList.remove('bump');
                void badge.offsetWidth;
                badge.classList.add('bump');
            }
        } else if (badge) {
            badge.remove();
        }
    }

    // Dirección de la foto de un producto.
    const urlFoto = p => (p && p.tiene_foto)
        ? '/api/producto/' + p.id_producto + '/foto?v=' + (p.foto_v || 0)
        : '';

    const urlFotoPromo = pr => (pr && pr.tiene_foto)
        ? '/api/promocion/' + pr.id_promocion + '/foto?v=' + (pr.foto_v || 0)
        : '';

    let animarRejilla = false;

    function renderProducts() {
        const grid = document.getElementById('product-grid');
        const animar = animarRejilla;
        animarRejilla = false;
        grid.innerHTML = '';

        const searchInput = document.getElementById('product-search');
        const search = searchInput ? searchInput.value.toLowerCase() : '';
        const searchClearBtn = document.getElementById('search-clear-btn');
        if (searchClearBtn) searchClearBtn.classList.toggle('hide', search.length === 0);

        // Filter products based on search and category
        const filtered = (activeCategory === 'promociones' && !search)
            ? []
            : products.filter(p => {
                const matchesCat = search ? true : (p.id_categoria === activeCategory);
                const matchesSearch = !search || p.nombre.toLowerCase().includes(search) || (p.descripcion && p.descripcion.toLowerCase().includes(search));
                return matchesCat && matchesSearch;
            });

        // Promociones: se muestran al seleccionar la pestaña "Promociones" o al buscar
        const promosVisibles = (activeCategory === 'promociones' || search)
            ? promociones.filter(pr =>
                !search ||
                pr.nombre.toLowerCase().includes(search) ||
                (pr.descripcion && pr.descripcion.toLowerCase().includes(search)))
            : [];

        if (filtered.length === 0 && promosVisibles.length === 0) {
            grid.innerHTML = `<div class="empty-cart-msg">No se encontraron productos</div>`;
            return;
        }

        promosVisibles.forEach((pr, i) => {
            const caben = paquetesQueCaben(pr);
            const puestos = (cart.find(c => c.tipo === 'promo' && c.id_promocion === pr.id_promocion) || {}).cantidad || 0;
            const restante = Math.max(0, caben - puestos);
            const isOut = caben <= 0 || restante <= 0;
            const suelto = precioSuelto(pr);
            const ahorro = Math.round((suelto - Number(pr.precio)) * 100) / 100;
            const tope = 10;
            const pct = caben > 0 ? Math.min(100, Math.max(0, Math.round((caben / tope) * 100))) : 0;
            const statusClass = isOut ? 'out' : (pct <= 40 ? 'low' : 'normal');
            const strokeColor = isOut ? '#e5e7eb' : (pct <= 40 ? '#ef4444' : '#facc15');
            const pathLen = 216.77;
            const offset = pathLen * (1 - (isOut ? 0 : pct / 100));

            const card = document.createElement('div');
            card.className = `product-card promo-card ${animar ? 'enter' : ''} ${isOut ? 'out-of-stock' : ''}`;
            card.dataset.promo = pr.id_promocion;
            if (animar) card.style.animationDelay = Math.min(i, 11) * 25 + 'ms';

            const dentroItems = (pr.contenido || []).map(c => {
                const prod = products.find(p => p.id_producto === c.id_producto);
                return `${c.cantidad}× ${prod ? prod.nombre : 'prod'}`;
            }).join(' + ');

            const foto = urlFotoPromo(pr);
            const visual = foto
                ? `<img class="product-foto promo-foto ${isOut ? 'foto-agotada' : ''}" src="${foto}" alt="${escapeHtml(pr.nombre)}" loading="lazy" decoding="async">`
                : `<span class="emoji ${isOut ? 'foto-agotada' : ''}">🎁</span>`;

            const precioTexto = Number(pr.precio) % 1 === 0 ? 'BS ' + Math.round(pr.precio) : 'BS ' + Number(pr.precio).toFixed(2);

            card.innerHTML = `
                <span class="promo-badge-tag">PROMO</span>
                <div class="gauge-wrapper">
                    <svg class="gauge-svg" viewBox="0 0 120 120" width="130" height="130" aria-hidden="true">
                        <path class="gauge-track" d="M 27.47 92.53 A 46 46 0 1 1 92.53 92.53" fill="none" stroke="#e5e7eb" stroke-width="11" stroke-linecap="round" />
                        <path class="gauge-bar" d="M 27.47 92.53 A 46 46 0 1 1 92.53 92.53" fill="none" stroke="${strokeColor}" stroke-width="11" stroke-linecap="round" stroke-dasharray="${pathLen}" stroke-dashoffset="${offset}" />
                    </svg>
                    <div class="gauge-inner">
                        <svg class="gauge-cloud-bg" viewBox="0 0 100 100" aria-hidden="true">
                            <path d="M 50 12 C 63 12, 75 18, 81 28 C 88 39, 88 52, 83 63 C 86 74, 79 84, 69 88 C 58 91, 44 90, 34 85 C 23 88, 14 79, 13 68 C 11 56, 15 45, 20 36 C 16 26, 25 15, 36 13 C 41 12, 46 12, 50 12 Z" fill="#374151" />
                        </svg>
                        ${visual}
                        <div class="stamp-agotado ${isOut ? '' : 'hide'}">AGOTADO</div>
                    </div>
                    <div class="card-price-pill price"><span class="price-val">${precioTexto}</span></div>
                </div>
                <div class="card-lower-zone">
                    <svg class="card-mid-wave" viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden="true">
                        <path d="M 0 20 L 0 10 C 60 2, 130 16, 200 8 L 200 20 Z" fill="#f1f5f9" />
                    </svg>
                    <div class="card-mid-body">
                        <h3 class="product-card-title">${escapeHtml(pr.nombre)}</h3>
                        ${dentroItems ? `<div class="promo-items-text" title="${escapeHtml(dentroItems)}">${escapeHtml(dentroItems)}</div>` : ''}
                    </div>
                    <div class="stock-footer ${statusClass}">
                        <svg class="stock-footer-wave" viewBox="0 0 200 30" preserveAspectRatio="none" aria-hidden="true">
                            <path d="M 0 30 L 0 14 C 40 26, 75 4, 130 12 C 160 16, 185 8, 200 12 L 200 30 Z" fill="currentColor"></path>
                        </svg>
                        <div class="stock-footer-content">
                            <div class="stock-label-line">Combo disponible</div>
                            <div class="stock-units-line stock ${isOut ? 'out' : ''}">${isOut ? '0 COMBOS<span class="sr-only"> (Agotado)</span>' : `${caben} ${caben === 1 ? 'COMBO' : 'COMBOS'}`}</div>
                        </div>
                    </div>
                </div>
                ${puestos > 0 ? `<span class="cart-badge">${puestos}</span>` : ''}
            `;
            card.addEventListener('click', () => agregarPromocion(pr));
            grid.appendChild(card);
        });

        filtered.forEach((p, i) => {
            const unidades = unidadesEnCarrito(p.id_producto);
            const displayStock = p.stock_actual - unidades;
            const visibleStock = Math.max(0, displayStock);
            const tope = p.stock_tope || p.stock_actual || 10;
            const pct = tope > 0 ? Math.min(100, Math.max(0, Math.round((visibleStock / tope) * 100))) : (visibleStock > 0 ? 100 : 0);
            const isOut = displayStock <= 0;
            const statusClass = isOut ? 'out' : (pct <= 40 ? 'low' : 'normal');
            const strokeColor = isOut ? '#e5e7eb' : (pct <= 40 ? '#ef4444' : '#facc15');
            const pathLen = 216.77;
            const offset = pathLen * (1 - (isOut ? 0 : pct / 100));

            const card = document.createElement('div');
            card.className = `product-card ${p.requiere_acompanante ? 'con-acomp' : ''} ${animar ? 'enter' : ''} ${isOut ? 'out-of-stock' : ''}`;
            card.dataset.id = p.id_producto;
            if (animar) {
                card.style.animationDelay = Math.min(i, 11) * 25 + 'ms';
            }

            const foto = urlFoto(p);
            const visual = foto
                ? `<img class="product-foto ${isOut ? 'foto-agotada' : ''}" src="${foto}" alt="${escapeHtml(p.nombre)}" loading="lazy" decoding="async">`
                : `<span class="emoji ${isOut ? 'foto-agotada' : ''}">${emojiDe(p)}</span>`;

            const precioTexto = Number(p.precio_venta) % 1 === 0 ? 'BS ' + Math.round(p.precio_venta) : 'BS ' + Number(p.precio_venta).toFixed(2);

            card.innerHTML = `
                <div class="gauge-wrapper">
                    <svg class="gauge-svg" viewBox="0 0 120 120" width="130" height="130" aria-hidden="true">
                        <path class="gauge-track" d="M 27.47 92.53 A 46 46 0 1 1 92.53 92.53" fill="none" stroke="#e5e7eb" stroke-width="11" stroke-linecap="round" />
                        <path class="gauge-bar" d="M 27.47 92.53 A 46 46 0 1 1 92.53 92.53" fill="none" stroke="${strokeColor}" stroke-width="11" stroke-linecap="round" stroke-dasharray="${pathLen}" stroke-dashoffset="${offset}" />
                    </svg>
                    <div class="gauge-inner">
                        <svg class="gauge-cloud-bg" viewBox="0 0 100 100" aria-hidden="true">
                            <path d="M 50 12 C 63 12, 75 18, 81 28 C 88 39, 88 52, 83 63 C 86 74, 79 84, 69 88 C 58 91, 44 90, 34 85 C 23 88, 14 79, 13 68 C 11 56, 15 45, 20 36 C 16 26, 25 15, 36 13 C 41 12, 46 12, 50 12 Z" fill="#374151" />
                        </svg>
                        ${visual}
                        <div class="stamp-agotado ${isOut ? '' : 'hide'}">AGOTADO</div>
                    </div>
                    <div class="card-price-pill price"><span class="price-val">${precioTexto}</span></div>
                </div>
                <div class="card-lower-zone">
                    <svg class="card-mid-wave" viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden="true">
                        <path d="M 0 20 L 0 10 C 60 2, 130 16, 200 8 L 200 20 Z" fill="#f1f5f9" />
                    </svg>
                    <div class="card-mid-body">
                        <h3 class="product-card-title">${escapeHtml(p.nombre)}</h3>
                    </div>
                    <div class="stock-footer ${statusClass}">
                        <svg class="stock-footer-wave" viewBox="0 0 200 30" preserveAspectRatio="none" aria-hidden="true">
                            <path d="M 0 30 L 0 14 C 40 26, 75 4, 130 12 C 160 16, 185 8, 200 12 L 200 30 Z" fill="currentColor"></path>
                        </svg>
                        <div class="stock-footer-content">
                            <div class="stock-label-line">Stock: ${pct}%</div>
                            <div class="stock-units-line stock ${isOut ? 'out' : ''}">${isOut ? '0 UNIDADES<span class="sr-only"> (Agotado)</span>' : `${visibleStock} UDS`}</div>
                        </div>
                    </div>
                </div>
                ${unidades > 0 ? `<span class="cart-badge">${unidades}</span>` : ''}
            `;

            // El listener va siempre: si el producto se agota por el carrito, es
            // addToCart quien lo frena, y así no hay que recablear la tarjeta.
            card.addEventListener('click', () => addToCart(p));

            grid.appendChild(card);
        });
    }

    const searchInput = document.getElementById('product-search');
    if (searchInput) searchInput.addEventListener('input', renderProducts);

    const searchClearBtn = document.getElementById('search-clear-btn');
    if (searchClearBtn) {
        searchClearBtn.addEventListener('click', () => {
            if (searchInput) {
                searchInput.value = '';
                searchInput.focus();
            }
            renderProducts();
        });
    }

    // ==========================================
    // CONTADOR DEL TURNO
    // ==========================================
    // Lo que lleva cobrado ESTA tablet desde que se abrió la caja. No sale de
    // la base: es lo que ha pasado por delante de este cajero, que es justo lo
    // que le preguntan ("¿cuánto llevas?") y lo que va a tener que cuadrar con
    // el efectivo de su cajón al cerrar.
    //
    // Vive en la sesión y no en el servidor a propósito: si se recarga la
    // página vuelve a cero, y eso es correcto —lo que cuenta para el cierre es
    // el reporte, no este número—. Aquí sirve para orientarse, no para cuadrar.
    let turno = { total: 0, comandas: 0 };

    function anotarEnElTurno(importe) {
        turno.total += Number(importe) || 0;
        turno.comandas += 1;
        pintarTurno();
    }

    function pintarTurno() {
        const total = document.getElementById('turno-total');
        const n = document.getElementById('turno-comandas');
        if (total) total.textContent = turno.total.toFixed(2);
        if (n) n.textContent = turno.comandas;
    }

    // Vibración corta al tocar un producto.
    //
    // En una barra a oscuras y con la música alta no se oye el toque ni se ve
    // bien la pantalla: el golpecito en la mano es la única confirmación fiable
    // de que el producto entró.
    //
    // 15 ms no se notaban con la tablet apoyada en la mesa: el mueble se come
    // el pulso. 28 ms sí, y siguen sin cansar tras doscientos toques.
    //
    // No todos los navegadores la tienen (iOS no), y algunos exigen que la
    // página ya haya recibido una interacción. Por eso va envuelto: si no puede
    // vibrar, la venta sigue igual.
    function vibrar(ms) {
        try {
            if (navigator.vibrate) navigator.vibrate(ms);
        } catch (err) { /* sin vibración: no es motivo para cortar una venta */ }
    }

    // El carrito se mueve hasta la línea que acaba de cambiar.
    //
    // No siempre es la última: si vuelves a pulsar un whisky que ya estaba
    // arriba del todo, lo que hay que enseñar es esa línea, no el final de la
    // lista. Bajar siempre al fondo dejaba al cajero mirando un sitio donde no
    // había pasado nada.
    //
    // Se mueve con animación y no de golpe para que se vea el recorrido: así
    // se entiende que la lista se desplazó, en vez de parecer que cambió sola.
    function mostrarLinea(id_producto, clave) {
        const lista = document.getElementById('cart-items');
        if (!lista) return;

        // Por clave cuando la hay: un paquete no tiene id de producto, y dos
        // líneas del mismo producto con distinto acompañante comparten el id.
        const fila = clave
            ? lista.querySelector(`.cart-item[data-clave="${clave}"]`)
            : lista.querySelector(`.cart-item[data-id="${id_producto}"]`);
        // requestAnimationFrame: si se llama antes de que el navegador haya
        // pintado la línea nueva, la altura todavía es la de antes y el scroll
        // se queda a media línea del final.
        // requestAnimationFrame: si se llama antes de que el navegador haya
        // pintado la línea, su posición todavía es la de antes y el desplazamiento
        // se queda corto.
        requestAnimationFrame(() => {
            const destino = fila
                // La línea, centrada en lo posible dentro de la ventana visible:
                // así se ve también la de encima y la de debajo, y se entiende
                // dónde está dentro del pedido.
                ? fila.offsetTop - (lista.clientHeight - fila.offsetHeight) / 2
                : lista.scrollHeight;

            const tope = Math.max(0, Math.min(destino, lista.scrollHeight - lista.clientHeight));

            // Quien haya pedido menos movimiento en su tablet recibe el salto
            // seco: sigue viendo la línea, sin el recorrido.
            const suave = !window.matchMedia ||
                !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            try {
                lista.scrollTo({ top: tope, behavior: suave ? 'smooth' : 'auto' });
            } catch (err) {
                lista.scrollTop = tope;   // navegadores sin scrollTo
            }

            // Un destello corto en la línea tocada. Con el carrito ya a la vista
            // el desplazamiento no se nota, y sin esto no hay forma de saber
            // cuál de las quince líneas acaba de subir.
            if (fila) {
                fila.classList.remove('tocada');
                // Forzar el reflow reinicia la animación cuando se pulsa el
                // mismo producto dos veces seguidas; sin esto, la segunda no se
                // ve porque la clase nunca llegó a quitarse del todo.
                void fila.offsetWidth;
                fila.classList.add('tocada');
            }
        });
    }

    // Cuántas unidades de un producto hay ya comprometidas en el carrito,
    // sumando las que van sueltas y las que van de acompañante. Un refresco
    // sale de la misma nevera vaya cobrado o de regalo.
    function unidadesEnCarrito(id_producto) {
        return unidadesEnCarritoSalvo(id_producto, null);
    }

    /**
     * Lo mismo, pero sin contar una línea concreta.
     *
     * Hace falta para preguntar "¿cuánto cabría aquí si esta línea no
     * existiera?", que es lo que hay que saber al reajustar el carrito cuando
     * otra tablet ha vendido: si se contara la propia línea, siempre parecería
     * que no cabe y se borraría sola.
     */
    function unidadesEnCarritoSalvo(id_producto, excluir) {
        return cart.reduce((n, item) => {
            if (excluir && item === excluir) return n;
            // Un paquete no es un producto: lo que reserva de la nevera es lo
            // que lleva dentro. Sin esto, meter dos combos en el carrito no
            // bajaría las existencias que se ven en las tarjetas y se podría
            // vender la misma cerveza dos veces.
            if (item.tipo === 'promo') {
                let dentro = 0;
                (item.contenido || []).forEach(c => {
                    if (c.id_producto === id_producto) dentro += c.cantidad * item.cantidad;
                });
                return n + dentro;
            }

            let suma = item.id_producto === id_producto ? item.cantidad : 0;
            // Los acompañantes llevan cantidad POR BOTELLA: dos colas pequeñas
            // en una línea de tres whiskys son seis colas fuera de la nevera.
            (item.acompanantes || []).forEach(a => {
                if (a.id_producto === id_producto) suma += a.cantidad * item.cantidad;
            });
            return n + suma;
        }, 0);
    }

    // Cuántas veces cabe todavía este paquete, mirando el producto que antes se
    // agote. Devuelve 0 si ya no cabe ninguno más.
    function paquetesQueCaben(promo, excluir) {
        const contenido = promo.contenido || [];
        if (contenido.length === 0) return 0;
        let caben = Infinity;
        for (const c of contenido) {
            const prod = products.find(p => p.id_producto === c.id_producto);
            if (!prod) return 0;
            const libres = prod.stock_actual - unidadesEnCarritoSalvo(c.id_producto, excluir);
            caben = Math.min(caben, Math.floor(libres / c.cantidad));
        }
        return caben === Infinity ? 0 : Math.max(0, caben);
    }

    // Lo que costaría suelto, para poder enseñar el ahorro.
    function precioSuelto(promo) {
        return (promo.contenido || []).reduce((s, c) => {
            const prod = products.find(p => p.id_producto === c.id_producto);
            return s + (prod ? Number(prod.precio_venta) * c.cantidad : 0);
        }, 0);
    }

    // La línea del carrito se identifica por el par (producto, acompañante).
    // Dos whiskys, uno con Coca y otro con Sprite, son dos líneas distintas
    // aunque el whisky sea el mismo: si se fundieran, no habría forma de saber
    // cuál lleva cuál al prepararlos.
    // Firma del acompañamiento de una línea, para poder compararlas. Ordenada
    // por id: elegir "2 colas + 1 tónica" y "1 tónica + 2 colas" tiene que dar
    // la misma línea.
    const firmaAcomp = acomps => (acomps || [])
        .slice()
        .sort((a, b) => a.id_producto - b.id_producto)
        .map(a => a.id_producto + 'x' + a.cantidad)
        .join(',');

    const mismaLinea = (item, id_producto, acomps) =>
        item.id_producto === id_producto &&
        firmaAcomp(item.acompanantes) === firmaAcomp(acomps);

    // Cart Lógica
    // Un paquete al carrito. Va aparte de addToCart porque no comparte casi
    // nada: no tiene stock propio que mirar sino el de su contenido, no admite
    // acompañantes —lo que lleva dentro ya está decidido al crearlo— y su
    // precio es el del paquete, no el de ningún producto.
    function agregarPromocion(promo) {
        if (paquetesQueCaben(promo) <= 0) {
            vibrar([25, 40, 25]);
            notify('No queda stock para armar "' + promo.nombre + '".', 'warn');
            return;
        }

        vibrar(28);
        const clave = 'promo:' + promo.id_promocion;
        const ya = cart.find(item => claveLinea(item) === clave);
        if (ya) {
            ya.cantidad++;
        } else {
            cart.push({
                tipo: 'promo',
                id_promocion: promo.id_promocion,
                nombre: promo.nombre,
                precio_venta: Number(promo.precio),
                cantidad: 1,
                // Se guarda una copia del contenido: si el admin cambia el
                // paquete mientras hay uno en el carrito, el que ya está puesto
                // no cambia debajo del dedo del cajero. El servidor validará el
                // suyo de todas formas al cobrar.
                contenido: (promo.contenido || []).map(c => {
                    const prod = products.find(p => p.id_producto === c.id_producto);
                    return {
                        id_producto: c.id_producto,
                        cantidad: c.cantidad,
                        nombre: prod ? prod.nombre : 'producto #' + c.id_producto
                    };
                })
            });
        }

        renderCart();
        actualizarTarjetaPromo(promo.id_promocion, true);
        (promo.contenido || []).forEach(c => actualizarTarjeta(c.id_producto, false));
        mostrarLinea(null, clave);
    }

    function addToCart(product, acompanantes) {
        if (unidadesEnCarrito(product.id_producto) >= product.stock_actual) {
            // Dos pulsos, distintos del toque normal: se nota en la mano que
            // eso NO entró, sin tener que leer el aviso.
            vibrar([25, 40, 25]);
            notify('No queda stock de ' + product.nombre + '.', 'warn');
            return;
        }

        // Si la botella lleva acompañamiento, se pregunta ANTES de meterla.
        // Preguntarlo al cobrar sería tarde: el mesero ya se habría ido con el
        // pedido tomado y habría que salir a buscarlo.
        if (product.requiere_acompanante && !acompanantes) {
            abrirCuadroAcompanante(product);
            return;
        }

        const acomps = acompanantes || [];

        // Los acompañantes también salen del almacén: si no queda, no se puede
        // prometer. Mejor enterarse aquí que en la barra.
        for (const a of acomps) {
            const cat = products.find(p => p.id_producto === a.id_producto);
            const disponible = cat ? cat.stock_actual - unidadesEnCarrito(a.id_producto) : 0;
            if (disponible < a.cantidad) {
                vibrar([25, 40, 25]);
                notify('No queda ' + a.nombre + ' para acompañar.', 'warn');
                return;
            }
        }

        const existing = cart.find(item => mismaLinea(item, product.id_producto, acomps));

        if (existing) {
            existing.cantidad++;
            actualizarLinea(existing);
        } else {
            cart.push({
                id_producto: product.id_producto,
                nombre: product.nombre,
                precio_venta: parseFloat(product.precio_venta),
                cantidad: 1,
                stock_max: product.stock_actual,
                acompanantes: acomps
            });
            renderCart();
        }

        recalcularTotal();
        actualizarTarjeta(product.id_producto, true);
        acomps.forEach(a => actualizarTarjeta(a.id_producto, true));
        vibrar(28);
        mostrarLinea(product.id_producto);
    }

    // ==========================================
    // MOVER STOCK A OTRA BARRA
    // ==========================================
    // Tres pasos, uno por pantalla: destino, producto y unidades. De uno en uno
    // porque esto se hace de pie y con prisa: un formulario con cinco campos a
    // la vez se rellena mal y se descubre al día siguiente, cuando falta media
    // caja y nadie sabe a dónde fue.
    //
    // Al confirmar sale la comanda impresa para el bartender que entrega.
    const moverModal = document.getElementById('mover-modal');
    let moverDestino = '';
    let moverProducto = null;
    let moverPendientes = [];      // lo que ya se ha añadido a este movimiento
    let moverDestinosUsados = [];
    // El mismo asistente sirve para las dos direcciones: los tres pasos son los
    // mismos y sólo cambian las palabras y el signo del stock. Duplicarlo sería
    // duplicar también cada arreglo que le haga falta después.
    let moverModo = 'SALIDA';      // 'SALIDA' (se va) | 'ENTRADA' (llega)
    let moverMotivo = 'TRASPASO';  // sólo en ENTRADA: 'COMPRA' | 'TRASPASO'

    const saliendo = () => moverModo === 'SALIDA';

    function abrirMoverStock(modo) {
        moverModo = modo === 'ENTRADA' ? 'ENTRADA' : 'SALIDA';
        moverMotivo = saliendo() ? 'TRASPASO' : 'COMPRA';
        moverDestino = '';
        moverProducto = null;
        moverPendientes = [];
        document.getElementById('mover-destino').value = '';
        document.getElementById('mover-buscar').value = '';
        document.getElementById('mover-nota').value = '';

        // El selector compra/traspaso sólo tiene sentido al agregar.
        document.getElementById('mover-motivos').classList.toggle('hide', saliendo());
        document.querySelectorAll('#mover-motivos .ingreso-tipo').forEach(b =>
            b.classList.toggle('activa', b.dataset.motivo === moverMotivo));

        document.getElementById('mover-confirmar').textContent =
            saliendo() ? 'Confirmar y imprimir' : 'Registrar entrada';

        pintarPendientes();
        cargarDestinosUsados();
        moverPaso(1);
        if (typeof cerrarSidebarMobile === 'function') cerrarSidebarMobile();
        moverModal.classList.remove('hide');
    }

    function cerrarMoverStock() {
        moverModal.classList.add('hide');
    }

    function moverPaso(n) {
        [1, 2, 3].forEach(i => {
            document.getElementById('mover-p' + i).classList.toggle('hide', i !== n);
            const marca = document.querySelector(`.mover-paso[data-paso="${i}"]`);
            if (marca) {
                marca.classList.toggle('activa', i === n);
                marca.classList.toggle('hecha', i < n);
            }
        });

        const titulo = document.getElementById('mover-titulo');
        const sub = document.getElementById('mover-subtitulo');
        const campo = document.getElementById('mover-destino');

        if (n === 1) {
            if (saliendo()) {
                titulo.textContent = '¿A dónde va?';
                sub.textContent = 'Barra o almacén que la recibe';
                campo.placeholder = 'Ej. Barra VIP';
            } else if (moverMotivo === 'COMPRA') {
                titulo.textContent = '¿A quién se compró?';
                sub.textContent = 'Proveedor que trae la mercancía';
                campo.placeholder = 'Ej. Distribuidora Central';
            } else {
                titulo.textContent = '¿De dónde llega?';
                sub.textContent = 'Barra que manda la mercancía';
                campo.placeholder = 'Ej. Barra VIP';
            }
        } else if (n === 2) {
            titulo.textContent = '¿Qué producto?';
            sub.textContent = (saliendo() ? 'Va a ' : 'Llega de ') + moverDestino;
            pintarProductosMover();
            document.getElementById('mover-buscar').focus();
        } else {
            titulo.textContent = '¿Cuántas unidades?';
            sub.textContent = moverProducto
                ? (saliendo() ? moverProducto.nombre + ' → ' + moverDestino
                              : moverDestino + ' → ' + moverProducto.nombre)
                : '';
        }
    }

    async function cargarDestinosUsados() {
        const caja = document.getElementById('mover-destinos-usados');
        caja.innerHTML = '';
        try {
            const res = await fetch('/api/traspasos');
            const data = await res.json();
            // Sólo destinos de salidas: para mandar mercancía no sirve de nada
            // sugerir el proveedor al que se le compró.
            // Se sugieren los de la misma dirección: para mandar mercancía no
            // sirve de nada ofrecer el proveedor al que se le compró.
            moverDestinosUsados = (data.destinos || [])
                .filter(d => d.tipo === moverModo).map(d => d.contraparte);
        } catch (err) {
            moverDestinosUsados = [];
        }

        // Sugerir los ya usados evita que "Barra VIP", "barra vip" y "VIP"
        // acaben siendo tres destinos distintos que no se pueden sumar.
        moverDestinosUsados.slice(0, 6).forEach(d => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mover-sugerencia';
            b.textContent = d;
            b.addEventListener('click', () => {
                document.getElementById('mover-destino').value = d;
                pasarAProducto();
            });
            caja.appendChild(b);
        });
    }

    function pasarAProducto() {
        const valor = document.getElementById('mover-destino').value.trim();
        if (!valor) {
            notify('Escribe a dónde va la mercancía.', 'warn');
            return;
        }
        moverDestino = valor;
        moverPaso(2);
    }

    function pintarProductosMover() {
        const caja = document.getElementById('mover-productos');
        const filtro = document.getElementById('mover-buscar').value.trim().toLowerCase();
        caja.innerHTML = '';

        // Lo que ya está apartado en este mismo traspaso se descuenta de lo que
        // se ofrece: si no, se podrían mandar 30 de algo de lo que quedan 20.
        const apartado = id => moverPendientes
            .filter(p => p.id_producto === id)
            .reduce((n, p) => n + p.cantidad, 0);

        // Al agregar no se filtra por stock: justamente lo que no queda es lo
        // que se va a reponer, y esconderlo lo haría imposible.
        const lista = products
            .filter(p => !saliendo() || (p.stock_actual - apartado(p.id_producto)) > 0)
            .filter(p => !filtro || p.nombre.toLowerCase().includes(filtro));

        if (!lista.length) {
            const vacio = document.createElement('p');
            vacio.className = 'mover-vacio';
            vacio.textContent = filtro ? 'Ningún producto con ese nombre.' : 'No queda stock que mover.';
            caja.appendChild(vacio);
            return;
        }

        lista.forEach(p => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mover-producto';

            const nombre = document.createElement('span');
            nombre.className = 'mover-producto-nombre';
            nombre.textContent = p.nombre;
            b.appendChild(nombre);

            const stock = document.createElement('span');
            stock.className = 'mover-producto-stock';
            stock.textContent = (p.stock_actual - apartado(p.id_producto)) + ' u.';
            b.appendChild(stock);

            b.addEventListener('click', () => {
                moverProducto = p;
                document.getElementById('mover-elegido').textContent = p.nombre;
                document.getElementById('mover-unidades').value = 1;
                pintarDisponible();
                pintarRapidos();
                moverPaso(3);
            });
            caja.appendChild(b);
        });
    }

    function disponibleDe(p) {
        const apartado = moverPendientes
            .filter(x => x.id_producto === p.id_producto)
            .reduce((n, x) => n + x.cantidad, 0);
        return p.stock_actual - apartado;
    }

    function pintarDisponible() {
        if (!moverProducto) return;
        document.getElementById('mover-disponible').textContent = saliendo()
            ? 'Quedan ' + disponibleDe(moverProducto) + ' en esta barra'
            : 'Ahora hay ' + moverProducto.stock_actual + ' en esta barra';
    }

    // Cantidades de caja: mover mercancía va de seis en seis o de doce en doce,
    // no de una en una. Teclear "24" con el dedo es donde se equivoca.
    // Los atajos de cantidad (6, 12, 24, "Todo") se retiraron junto con los de
    // efectivo: un botón que rellena una cifra por ti se pulsa sin mirar, y en
    // stock eso es mercancía que se mueve sola. La cantidad se teclea.
    function pintarRapidos() {
        const caja = document.getElementById('mover-rapidos');
        if (caja) caja.innerHTML = '';
    }

    function pintarPendientes() {
        const caja = document.getElementById('mover-lista');
        caja.innerHTML = '';

        const confirmar = document.getElementById('mover-confirmar');
        if (confirmar) {
            const base = saliendo() ? 'Confirmar y imprimir' : 'Registrar entrada';
            confirmar.textContent = moverPendientes.length
                ? base + ' (' + moverPendientes.length + ')'
                : base;
        }

        if (!moverPendientes.length) return;

        moverPendientes.forEach((p, i) => {
            const fila = document.createElement('div');
            fila.className = 'mover-pendiente';

            const txt = document.createElement('span');
            txt.textContent = p.cantidad + ' × ' + p.nombre;
            fila.appendChild(txt);

            const quitar = document.createElement('button');
            quitar.type = 'button';
            quitar.className = 'mover-quitar';
            quitar.textContent = '✕';
            quitar.setAttribute('aria-label', 'Quitar ' + p.nombre);
            quitar.addEventListener('click', () => {
                moverPendientes.splice(i, 1);
                pintarPendientes();
                pintarDisponible();
            });
            fila.appendChild(quitar);

            caja.appendChild(fila);
        });
    }

    function apuntarLoElegido() {
        if (!moverProducto) return false;
        const n = parseInt(document.getElementById('mover-unidades').value, 10);
        if (!Number.isInteger(n) || n <= 0) {
            notify('Pon cuántas unidades vas a mover.', 'warn');
            return false;
        }
        if (saliendo() && n > disponibleDe(moverProducto)) {
            notify('Sólo quedan ' + disponibleDe(moverProducto) + ' de ' + moverProducto.nombre + '.', 'warn');
            return false;
        }
        moverPendientes.push({
            id_producto: moverProducto.id_producto,
            nombre: moverProducto.nombre,
            cantidad: n
        });
        pintarPendientes();
        return true;
    }

    async function confirmarTraspaso() {
        const uInput = document.getElementById('mover-unidades');
        const n = uInput ? parseInt(uInput.value, 10) : 0;
        if (moverProducto && Number.isInteger(n) && n > 0) {
            apuntarLoElegido();
        }

        if (!moverPendientes || moverPendientes.length === 0) {
            notify('Añade al menos un producto a la lista.', 'warn');
            return;
        }

        const boton = document.getElementById('mover-confirmar');
        boton.disabled = true;
        try {
            const res = await fetch('/api/traspaso', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tipo: moverModo,
                    motivo: saliendo() ? 'TRASPASO' : moverMotivo,
                    contraparte: moverDestino,
                    observaciones: document.getElementById('mover-nota').value.trim(),
                    id_cajero: currentUser ? currentUser.id_cajero : null,
                    items: moverPendientes.map(p => ({ id_producto: p.id_producto, cantidad: p.cantidad }))
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo registrar el traspaso.', 'error', 7000);
                return;
            }

            cerrarMoverStock();
            notify(data.message, 'ok', 6000);
            vibrar([30, 60, 30]);
            // El stock de la caja tiene que reflejar de inmediato lo que se fue,
            // o el cajero seguiría vendiendo lo que ya está en la otra barra.
            await fetchProductsAndMenu();
            // La comanda se imprime en las dos direcciones: al mandar sirve de
            // entrega, y al recibir de acuse. En los dos casos alguien tiene
            // que poder demostrar que la mercancía cambió de manos.
            imprimirTraspaso(data);
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        } finally {
            boton.disabled = false;
        }
    }

    // La comanda del traspaso: la misma vista previa y la misma impresora que
    // los tickets de venta, para que el bartender vea siempre el mismo papel.
    function imprimirTraspaso(data) {
        const ahora = new Date();
        const dos = n => String(n).padStart(2, '0');
        const modelo = {
            id: data.id_traspaso,
            tipo: data.tipo,
            motivo: data.motivo,
            barra: configEvento.barra || instancia.nombre || 'Barra',
            contraparte: data.contraparte,
            fecha: dos(ahora.getDate()) + '/' + dos(ahora.getMonth() + 1) + '/' + ahora.getFullYear(),
            hora: dos(ahora.getHours()) + ':' + dos(ahora.getMinutes()),
            responsable: currentUser ? currentUser.nombre : '',
            observaciones: data.observaciones || '',
            items: data.items || []
        };

        const ajustes = ThermalPrinter.getSettings();
        const ops = ThermalPrinter.buildTraspasoOps(modelo, ajustes);

        traspasoParaImprimir = { ops: ops, modelo: modelo };
        document.getElementById('traspaso-body').innerHTML =
            ThermalPrinter.helpers.opsToHtml(ops, ajustes);
        document.getElementById('traspaso-modal').classList.remove('hide');
    }

    let traspasoParaImprimir = null;

    document.getElementById('mover-stock-btn')
        .addEventListener('click', () => abrirMoverStock('SALIDA'));
    document.getElementById('agregar-stock-btn')
        .addEventListener('click', () => abrirMoverStock('ENTRADA'));

    document.querySelectorAll('#mover-motivos .ingreso-tipo').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#mover-motivos .ingreso-tipo')
                .forEach(b => b.classList.remove('activa'));
            btn.classList.add('activa');
            moverMotivo = btn.dataset.motivo;
            // El rótulo cambia con el motivo: no se pregunta igual por un
            // proveedor que por la barra de al lado.
            moverPaso(1);
            cargarDestinosUsados();
        });
    });
    document.getElementById('mover-cerrar').addEventListener('click', cerrarMoverStock);
    moverModal.addEventListener('click', e => {
        if (e.target === moverModal) cerrarMoverStock();
    });
    document.getElementById('mover-a-producto').addEventListener('click', pasarAProducto);
    document.getElementById('mover-destino').addEventListener('keydown', e => {
        if (e.key === 'Enter') pasarAProducto();
    });
    document.getElementById('mover-buscar').addEventListener('input', pintarProductosMover);
    document.getElementById('mover-menos').addEventListener('click', () => {
        const campo = document.getElementById('mover-unidades');
        campo.value = Math.max(1, (parseInt(campo.value, 10) || 1) - 1);
        vibrar(20);
    });
    document.getElementById('mover-mas').addEventListener('click', () => {
        const campo = document.getElementById('mover-unidades');
        const tope = moverProducto ? disponibleDe(moverProducto) : 1;
        campo.value = Math.min(tope, (parseInt(campo.value, 10) || 0) + 1);
        vibrar(20);
    });
    document.getElementById('mover-otro').addEventListener('click', () => {
        if (!apuntarLoElegido()) return;
        moverProducto = null;
        document.getElementById('mover-buscar').value = '';
        moverPaso(2);
    });
    document.getElementById('mover-confirmar').addEventListener('click', confirmarTraspaso);

    document.getElementById('traspaso-cerrar').addEventListener('click', () => {
        document.getElementById('traspaso-modal').classList.add('hide');
        traspasoParaImprimir = null;
    });

    document.getElementById('traspaso-imprimir').addEventListener('click', () => {
        if (!traspasoParaImprimir) return;
        try {
            ThermalPrinter.printOps(traspasoParaImprimir.ops);
            notify('Enviado a la impresora.', 'ok');
        } catch (err) {
            notify('No se pudo imprimir: ' + (err.message || 'revisa RawBT'), 'error');
        }
    });

    // ==========================================
    // MENÚ LATERAL PLEGABLE (ESTE TURNO / MERCANCÍA)
    // ==========================================
    const posLayout = document.getElementById('pos-layout');
    const posSidebar = document.getElementById('pos-sidebar');
    const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
    const closeSidebarBtn = document.getElementById('close-sidebar-btn');
    const sidebarBackdrop = document.getElementById('pos-sidebar-backdrop');

    function inicializarSidebarPlegable() {
        const guardado = localStorage.getItem('pos_sidebar_collapsed');
        if (guardado === 'true' && posLayout) {
            posLayout.classList.add('sidebar-collapsed');
            if (toggleSidebarBtn) toggleSidebarBtn.classList.add('active');
        }
    }

    function togglePosSidebar() {
        if (!posLayout || !posSidebar) return;
        const isMobile = window.innerWidth <= 820;

        if (isMobile) {
            const isOpen = posSidebar.classList.contains('mobile-open');
            if (isOpen) {
                cerrarSidebarMobile();
            } else {
                abrirSidebarMobile();
            }
        } else {
            const isCollapsed = posLayout.classList.toggle('sidebar-collapsed');
            localStorage.setItem('pos_sidebar_collapsed', isCollapsed ? 'true' : 'false');
            if (toggleSidebarBtn) {
                toggleSidebarBtn.classList.toggle('active', isCollapsed);
            }
        }
    }

    function abrirSidebarMobile() {
        if (!posSidebar) return;
        posSidebar.classList.add('mobile-open');
        if (sidebarBackdrop) sidebarBackdrop.classList.remove('hide');
        if (toggleSidebarBtn) toggleSidebarBtn.classList.add('active');
    }

    function cerrarSidebarMobile() {
        if (!posSidebar) return;
        posSidebar.classList.remove('mobile-open');
        if (sidebarBackdrop) sidebarBackdrop.classList.add('hide');
        if (toggleSidebarBtn) toggleSidebarBtn.classList.remove('active');
    }

    if (toggleSidebarBtn) {
        toggleSidebarBtn.addEventListener('click', togglePosSidebar);
    }
    if (closeSidebarBtn) {
        closeSidebarBtn.addEventListener('click', () => {
            if (window.innerWidth <= 820) {
                cerrarSidebarMobile();
            } else {
                if (posLayout) posLayout.classList.add('sidebar-collapsed');
                localStorage.setItem('pos_sidebar_collapsed', 'true');
                if (toggleSidebarBtn) toggleSidebarBtn.classList.add('active');
            }
        });
    }
    if (sidebarBackdrop) {
        sidebarBackdrop.addEventListener('click', cerrarSidebarMobile);
    }

    inicializarSidebarPlegable();

    // ==========================================
    // CUADRO DE ACOMPAÑANTE
    // ==========================================
    const acompModal = document.getElementById('acomp-modal');
    let productoEsperandoAcompanante = null;

    // Lo elegido en el cuadro: { id_producto -> cantidad por botella }.
    let acompElegidos = new Map();

    function abrirCuadroAcompanante(product) {
        productoEsperandoAcompanante = product;
        acompElegidos = new Map();
        document.getElementById('acomp-producto').textContent = product.nombre;

        pintarOpcionesAcompanante();
        acompModal.classList.remove('hide');
    }

    function pintarOpcionesAcompanante() {
        const caja = document.getElementById('acomp-opciones');
        const vacio = document.getElementById('acomp-vacio');
        caja.innerHTML = '';

        // TODOS los marcados como acompañante, agotados incluidos.
        //
        // Antes se escondían los que no tenían stock, y eso dejaba al cajero
        // buscando una Coca-Cola que sí existe pero se acabó, sin entender por
        // qué no aparece. Sale, marcada como agotada y sin poder tocarse: se ve
        // que se acabó y se elige otra cosa.
        const opciones = products.filter(p => p.es_acompanante);
        vacio.classList.toggle('hide', opciones.length > 0);

        opciones.forEach(p => {
            const unidades = unidadesEnCarrito(p.id_producto);
            const disponible = p.stock_actual - unidades;
            const visibleStock = Math.max(0, disponible);
            const tope = p.stock_tope || p.stock_actual || 10;
            const pct = tope > 0 ? Math.min(100, Math.max(0, Math.round((visibleStock / tope) * 100))) : (visibleStock > 0 ? 100 : 0);
            const puestas = acompElegidos.get(p.id_producto) || 0;
            const agotado = disponible <= 0;
            const statusClass = agotado ? 'out' : (pct <= 40 ? 'low' : 'normal');
            const strokeColor = agotado ? '#e5e7eb' : (pct <= 40 ? '#ef4444' : '#facc15');
            const pathLen = 216.77;
            const offset = pathLen * (1 - (agotado ? 0 : pct / 100));

            const card = document.createElement('div');
            card.className = `product-card acomp-card-item ${agotado ? 'out-of-stock' : ''} ${puestas > 0 ? 'elegida' : ''}`;
            card.dataset.id = p.id_producto;

            const foto = urlFoto(p);
            const visual = foto
                ? `<img class="product-foto ${agotado ? 'foto-agotada' : ''}" src="${foto}" alt="${escapeHtml(p.nombre)}" loading="lazy" decoding="async">`
                : `<span class="emoji ${agotado ? 'foto-agotada' : ''}">${emojiDe(p)}</span>`;

            card.innerHTML = `
                <div class="gauge-wrapper">
                    <svg class="gauge-svg" viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">
                        <path class="gauge-track" d="M 27.47 92.53 A 46 46 0 1 1 92.53 92.53" fill="none" stroke="#e5e7eb" stroke-width="11" stroke-linecap="round" />
                        <path class="gauge-bar" d="M 27.47 92.53 A 46 46 0 1 1 92.53 92.53" fill="none" stroke="${strokeColor}" stroke-width="11" stroke-linecap="round" stroke-dasharray="${pathLen}" stroke-dashoffset="${offset}" />
                    </svg>
                    <div class="gauge-inner">
                        <svg class="gauge-cloud-bg" viewBox="0 0 100 100" aria-hidden="true">
                            <path d="M 50 12 C 63 12, 75 18, 81 28 C 88 39, 88 52, 83 63 C 86 74, 79 84, 69 88 C 58 91, 44 90, 34 85 C 23 88, 14 79, 13 68 C 11 56, 15 45, 20 36 C 16 26, 25 15, 36 13 C 41 12, 46 12, 50 12 Z" fill="#374151" />
                        </svg>
                        ${visual}
                        <div class="stamp-agotado ${agotado ? '' : 'hide'}">AGOTADO</div>
                    </div>
                    <div class="card-price-pill price"><span class="price-val">INCLUIDO</span></div>
                </div>
                <div class="card-lower-zone">
                    <svg class="card-mid-wave" viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden="true">
                        <path d="M 0 20 L 0 10 C 60 2, 130 16, 200 8 L 200 20 Z" fill="#f1f5f9" />
                    </svg>
                    <div class="card-mid-body">
                        <h3 class="product-card-title">${escapeHtml(p.nombre)}</h3>
                    </div>
                    <div class="stock-footer ${statusClass}">
                        <svg class="stock-footer-wave" viewBox="0 0 200 30" preserveAspectRatio="none" aria-hidden="true">
                            <path d="M 0 30 L 0 14 C 40 26, 75 4, 130 12 C 160 16, 185 8, 200 12 L 200 30 Z" fill="currentColor"></path>
                        </svg>
                        <div class="stock-footer-content">
                            <div class="stock-label-line">Stock: ${pct}% · ${visibleStock} UDS</div>
                            <div class="acomp-control">
                                <button type="button" class="acomp-btn-circular acomp-btn-menos" aria-label="Menos" ${puestas === 0 ? 'disabled' : ''}>−</button>
                                <span class="acomp-cantidad-pill">${puestas}</span>
                                <button type="button" class="acomp-btn-circular acomp-btn-mas" aria-label="Más" ${puestas >= disponible || agotado ? 'disabled' : ''}>+</button>
                            </div>
                        </div>
                    </div>
                </div>
                ${puestas > 0 ? `<span class="cart-badge">${puestas}</span>` : ''}
            `;

            if (agotado) {
                caja.appendChild(card);
                return;
            }

            // 1. Botones + y -: Cambian cantidad y MANTIENEN abierta la ventana emergente
            const btnMenos = card.querySelector('.acomp-btn-menos');
            const btnMas = card.querySelector('.acomp-btn-mas');

            btnMenos.addEventListener('click', (e) => {
                e.stopPropagation();
                cambiarAcomp(p, -1);
            });

            btnMas.addEventListener('click', (e) => {
                e.stopPropagation();
                cambiarAcomp(p, +1);
            });

            // 2. Clic en la tarjeta / imagen: Selecciona directamente 1 unidad y CIERRA la ventana emergente
            card.addEventListener('click', (e) => {
                if (disponible <= 0) {
                    vibrar([25, 40, 25]);
                    notify('No queda más ' + p.nombre + '.', 'warn');
                    return;
                }
                const botella = productoEsperandoAcompanante;
                if (!botella) return;
                const elegidos = [{ id_producto: p.id_producto, nombre: p.nombre, cantidad: 1 }];
                cerrarCuadroAcompanante();
                addToCart(botella, elegidos);
                vibrar(25);
            });

            caja.appendChild(card);
        });

        pintarResumenAcompanante();
    }

    function cambiarAcomp(p, delta) {
        const disponible = p.stock_actual - unidadesEnCarrito(p.id_producto);
        const ahora = acompElegidos.get(p.id_producto) || 0;
        const nuevo = Math.max(0, Math.min(disponible, ahora + delta));
        if (nuevo === ahora) {
            if (delta > 0) {
                vibrar([25, 40, 25]);
                notify('No queda más ' + p.nombre + '.', 'warn');
            }
            return;
        }
        if (nuevo === 0) acompElegidos.delete(p.id_producto);
        else acompElegidos.set(p.id_producto, nuevo);
        vibrar(20);
        pintarOpcionesAcompanante();
    }

    function pintarResumenAcompanante() {
        const resumen = document.getElementById('acomp-resumen');
        const aceptar = document.getElementById('acomp-aceptar');
        if (!resumen || !aceptar) return;

        if (acompElegidos.size === 0) {
            resumen.textContent = 'Elige el acompañamiento';
            resumen.classList.remove('tiene');
            aceptar.disabled = true;
            return;
        }

        const partes = [];
        acompElegidos.forEach((cant, id) => {
            const p = products.find(x => x.id_producto === id);
            partes.push(cant + ' × ' + (p ? p.nombre : 'producto'));
        });
        resumen.textContent = partes.join('  ·  ');
        resumen.classList.add('tiene');
        aceptar.disabled = false;
    }

    function cerrarCuadroAcompanante() {
        acompModal.classList.add('hide');
        productoEsperandoAcompanante = null;
    }

    document.getElementById('acomp-aceptar').addEventListener('click', () => {
        if (!productoEsperandoAcompanante || acompElegidos.size === 0) return;
        const elegidos = [];
        acompElegidos.forEach((cantidad, id) => {
            const p = products.find(x => x.id_producto === id);
            elegidos.push({ id_producto: id, nombre: p ? p.nombre : 'Producto', cantidad });
        });
        const botella = productoEsperandoAcompanante;
        cerrarCuadroAcompanante();
        addToCart(botella, elegidos);
    });

    document.getElementById('acomp-cancelar').addEventListener('click', cerrarCuadroAcompanante);
    // Tocar fuera cancela: es lo que todo el mundo intenta primero, y aquí no
    // se pierde nada porque el producto todavía no entró en el carrito.
    acompModal.addEventListener('click', e => {
        if (e.target === acompModal) cerrarCuadroAcompanante();
    });

    // Suma del carrito. Vive aparte porque ahora se recalcula sin repintar nada.
    function recalcularTotal() {
        const total = cart.reduce((s, item) => s + item.precio_venta * item.cantidad, 0);
        const casilla = document.getElementById('cart-total-amount');
        const texto = `${total.toFixed(2)} Bs.`;

        // Un latido cuando la cifra cambia de verdad. El total es lo único de
        // la pantalla que el cajero dice en voz alta, y con el dedo encima de
        // la rejilla no siempre mira al carrito: el movimiento se ve de reojo
        // y confirma que el toque entró. Si no cambia no se mueve, para que no
        // se vuelva un tic que se deja de mirar.
        if (casilla.textContent !== texto) {
            casilla.textContent = texto;
            casilla.classList.remove('total-late');
            void casilla.offsetWidth;   // reinicia la animación
            casilla.classList.add('total-late');
        }

        const contador = document.getElementById('cart-count');
        contador.textContent = cart.length;
        contador.classList.toggle('tiene', cart.length > 0);

        updatePaymentDetails(total);
        return total;
    }

    // Una fila se identifica por el par producto+acompañante, no sólo por el
    // producto: puede haber dos whiskys en el carrito con refrescos distintos.
    const claveLinea = item => item.tipo === 'promo'
        ? 'promo:' + item.id_promocion
        : item.id_producto + '|' + firmaAcomp(item.acompanantes);

    function filaDe(item) {
        return document.querySelector(
            `.cart-item[data-clave="${claveLinea(item)}"]`);
    }

    // Cambia sólo los números de una línea ya pintada, sin tocar el resto del
    // carrito: subir una cantidad no debe hacer parpadear toda la lista.
    function actualizarLinea(item) {
        const fila = filaDe(item);
        if (!fila) return renderCart();

        const sub = item.precio_venta * item.cantidad;
        fila.querySelector('.price').textContent =
            `${item.precio_venta.toFixed(2)} x ${item.cantidad} = ${sub.toFixed(2)} Bs.`;
        fila.querySelector('.qty').textContent = item.cantidad;
        // Las cantidades de los acompañantes van con la de la línea.
        fila.querySelectorAll('.cart-acomp-cant').forEach((el, i) => {
            const a = (item.acompanantes || [])[i];
            if (a) el.textContent = a.cantidad * item.cantidad;
        });
    }

    function quitarDelCarrito(item) {
        // Un paquete se quita entero y devuelve a la rejilla el stock de todo
        // lo que llevaba dentro, así que se repintan todas sus tarjetas.
        if (item.tipo === 'promo') {
            cart = cart.filter(c => claveLinea(c) !== claveLinea(item));
            renderCart();
            recalcularTotal();
            renderProducts();
            return;
        }

        const acomps = item.acompanantes || [];
        cart = cart.filter(c => !mismaLinea(c, item.id_producto, acomps));
        renderCart();
        recalcularTotal();
        actualizarTarjeta(item.id_producto);
        acomps.forEach(a => actualizarTarjeta(a.id_producto));
    }

    function renderCart() {
        const container = document.getElementById('cart-items');
        // Las líneas que ya estaban no vuelven a animarse; sólo entra la nueva.
        const yaPintadas = new Set(
            [...container.querySelectorAll('.cart-item')].map(el => el.dataset.clave)
        );
        container.innerHTML = '';

        if (cart.length === 0) {
            container.innerHTML = `<div class="empty-cart-msg">El carrito está vacío</div>`;
            recalcularTotal();
            return;
        }

        cart.forEach(item => {
            const sub = item.precio_venta * item.cantidad;
            const clave = claveLinea(item);

            const div = document.createElement('div');
            div.className = 'cart-item' + (yaPintadas.has(clave) ? '' : ' enter');
            div.dataset.id = item.id_producto;
            div.dataset.clave = clave;

            // El acompañante va debajo y sangrado, sin importe: se lee de un
            // vistazo que va dentro de la botella y no que se cobra aparte.
            // Todos los acompañantes, cada uno con su cantidad ya multiplicada
            // por las botellas de la línea: es lo que hay que servir.
            // Un paquete se lee como una unidad: su nombre, su precio cerrado
            // y debajo lo que hay que servir. Nunca los precios repartidos: el
            // servidor los reparte para que cuadre el cierre, pero al cajero y
            // al cliente lo que les importa es "Combo Amigos, 60".
            const dentroHtml = item.tipo === 'promo'
                ? (item.contenido || []).map(c => `
                   <div class="cart-acomp">
                       <span class="cart-acomp-flecha" aria-hidden="true">↳</span>
                       <span class="cart-acomp-nombre">${escapeHtml(c.nombre)}</span>
                       <span class="cart-acomp-cant">${c.cantidad * item.cantidad}</span>
                   </div>`).join('')
                : '';

            const acompHtml = (item.acompanantes || []).map(a => `
                   <div class="cart-acomp">
                       <span class="cart-acomp-flecha" aria-hidden="true">↳</span>
                       <span class="cart-acomp-nombre">${escapeHtml(a.nombre)}</span>
                       <span class="cart-acomp-cant">${a.cantidad * item.cantidad}</span>
                       <span class="cart-acomp-gratis">incluido</span>
                   </div>`).join('');

            // Foto o icono del producto (y sus acompañantes en modo pack)
            let visualHtml = '';
            const acomps = item.acompanantes || [];

            if (item.tipo === 'promo') {
                visualHtml = `<span class="cart-item-emoji">🏷️</span>`;
            } else if (acomps.length > 0) {
                // Producto con acompañante(s) -> Composición PACK 3D (Botella al frente, Acompañante detrás)
                const prod = products.find(p => p.id_producto === item.id_producto);
                const fotoPrincipal = urlFoto(prod);

                // Primer acompañante para la composición
                const primerAcomp = acomps[0];
                const prodAcomp = products.find(p => p.id_producto === primerAcomp.id_producto);
                const fotoAcomp = urlFoto(prodAcomp);

                const htmlAcomp = fotoAcomp
                    ? `<img class="pack-img pack-acomp" src="${fotoAcomp}" alt="" loading="lazy">`
                    : `<span class="pack-emoji pack-acomp">${emojiDe(prodAcomp || primerAcomp)}</span>`;

                const htmlPrincipal = fotoPrincipal
                    ? `<img class="pack-img pack-principal" src="${fotoPrincipal}" alt="" loading="lazy">`
                    : `<span class="pack-emoji pack-principal">${emojiDe(prod || item)}</span>`;

                visualHtml = `
                    <div class="cart-pack-container">
                        ${htmlAcomp}
                        ${htmlPrincipal}
                    </div>
                `;
            } else {
                const prod = products.find(p => p.id_producto === item.id_producto);
                const foto = urlFoto(prod);
                if (foto) {
                    visualHtml = `<img class="cart-item-img" src="${foto}" alt="" loading="lazy">`;
                } else {
                    visualHtml = `<span class="cart-item-emoji">${emojiDe(prod || item)}</span>`;
                }
            }

            div.innerHTML = `
                <div class="cart-item-header">
                    <div class="cart-item-foto">${visualHtml}</div>
                    <div class="cart-item-info">
                        <h4>${item.tipo === 'promo' ? '<span class="cart-promo-sello">Promoción</span> ' : ''}${escapeHtml(item.nombre)}</h4>
                        <div class="price">${item.precio_venta.toFixed(2)} x ${item.cantidad} = ${sub.toFixed(2)} Bs.</div>
                    </div>
                </div>
                ${dentroHtml}
                ${acompHtml}
                <div class="cart-item-controls">
                    <button class="cart-qty-btn decrease-btn" aria-label="Quitar uno">−</button>
                    <span class="qty">${item.cantidad}</span>
                    <button class="cart-qty-btn increase-btn" aria-label="Añadir uno">+</button>
                    <button class="remove-item-btn" aria-label="Quitar del carrito" title="Quitar">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>
                        </svg>
                    </button>
                </div>
            `;

            // Qty listeners
            div.querySelector('.decrease-btn').addEventListener('click', () => {
                if (item.tipo === 'promo') {
                    if (item.cantidad > 1) item.cantidad--;
                    else cart = cart.filter(c => claveLinea(c) !== claveLinea(item));
                    vibrar([18, 30, 18]);
                    renderCart();
                    renderProducts();
                    return;
                }
                if (item.cantidad > 1) {
                    item.cantidad--;
                    actualizarLinea(item);
                    recalcularTotal();
                    actualizarTarjeta(item.id_producto, true);
                    (item.acompanantes || []).forEach(a => actualizarTarjeta(a.id_producto, true));
                } else {
                    quitarDelCarrito(item);
                }
            });

            div.querySelector('.increase-btn').addEventListener('click', () => {
                // Un paquete más sólo cabe si caben TODOS sus productos. Se
                // pregunta al catálogo vivo, igual que con lo demás.
                if (item.tipo === 'promo') {
                    const promo = promociones.find(p => p.id_promocion === item.id_promocion);
                    if (!promo || paquetesQueCaben(promo) <= 0) {
                        vibrar([25, 40, 25]);
                        notify('No queda stock para otro "' + item.nombre + '".', 'warn');
                        return;
                    }
                    item.cantidad++;
                    renderCart();
                    renderProducts();
                    vibrar(28);
                    return;
                }

                // Se consulta el stock vivo, no el que había al añadirlo: otra
                // tablet puede haber vendido unidades desde entonces.
                const enCatalogo = products.find(p => p.id_producto === item.id_producto);
                const tope = enCatalogo ? enCatalogo.stock_actual : item.stock_max;
                // unidadesEnCarrito y no item.cantidad: el mismo producto puede
                // estar además de acompañante en otra línea, y todo sale del
                // mismo almacén.
                if (unidadesEnCarrito(item.id_producto) >= tope) {
                    notify('No queda stock de ' + item.nombre + '.', 'warn');
                    return;
                }
                // Una botella más se lleva sus acompañantes: hay que
                // comprobar que quedan todos antes de subir la cantidad.
                for (const a of (item.acompanantes || [])) {
                    const cat = products.find(p => p.id_producto === a.id_producto);
                    const tope = cat ? cat.stock_actual : 0;
                    if (unidadesEnCarrito(a.id_producto) + a.cantidad > tope) {
                        notify('No queda ' + a.nombre + ' para acompañar.', 'warn');
                        return;
                    }
                }
                item.cantidad++;
                actualizarLinea(item);
                recalcularTotal();
                actualizarTarjeta(item.id_producto, true);
                (item.acompanantes || []).forEach(a => actualizarTarjeta(a.id_producto, true));
                // El "+" también es "poner en el carrito": mismo golpecito, o
                // el cajero no sabe cuál de sus toques contó.
                vibrar(28);
            });

            div.querySelector('.remove-item-btn').addEventListener('click', () => {
                vibrar([18, 30, 18]);
                quitarDelCarrito(item);
            });

            container.appendChild(div);
        });

        recalcularTotal();
    }

    document.getElementById('clear-cart').addEventListener('click', () => {
        // Antes vaciaba la lista pero dejaba el contador y el total con las
        // cifras anteriores: la pantalla decía "3" y "58.00 Bs." sobre un
        // carrito vacío. Ahora usa el mismo vaciado que salir sin cobrar.
        if (!cart.length) return;
        vibrar([20, 30, 20]);
        vaciarCarrito();
    });

    // ==========================================
    // 3. COBRO
    // ==========================================
    // El cobro ocurre en una sola pantalla: total arriba, forma de pago en
    // pestañas y un botón que confirma. Antes había que ir añadiendo pagos de
    // uno en uno con un "+", que con cola en la barra es un estorbo.
    let orderTotal = 0;

    const METODOS = {
        1: { nombre: 'Efectivo', ref: 'EFECTIVO-CAJA' },
        2: { nombre: 'Tarjeta', ref: 'TARJETA-OP' },
        3: { nombre: 'Código QR', ref: 'QR-MONEY' },
        4: { nombre: 'Transferencia', ref: 'TRANSF-OP' }
    };
    const EFECTIVO = 1;

    let metodoActivo = EFECTIVO;   // id_metodo_pago, o 'mixto'
    let efectivoRecibido = 0;      // billete con el que paga, sólo para el cambio

    const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    const payModal = document.getElementById('payment-modal');
    const payRecibidoInput = document.getElementById('pay-recibido');
    const payLineas = document.getElementById('pay-lineas');
    const payError = document.getElementById('pay-error');

    // Las líneas del pago mixto: [{ metodo, monto }]. Se arranca con dos porque
    // mixto con una sola línea es un pago normal, y quien abre esta pestaña ya
    // sabe que va a repartir.
    let lineasPago = [];

    // El carrito ya no lleva resumen de pagos: sólo el total y el botón de
    // cobrar, que se habilita en cuanto hay algo que cobrar.
    function updatePaymentDetails(total) {
        orderTotal = total;
        document.getElementById('finalize-order-btn').disabled = !(total > 0);
    }

    function mostrarErrorPago(mensaje) {
        if (!mensaje) {
            payError.classList.add('hide');
            return;
        }
        payError.textContent = mensaje;
        payError.classList.remove('hide');
    }

    const QR = 3;   // id_metodo_pago del código QR

    function seleccionarMetodo(metodo) {
        metodoActivo = metodo;
        mostrarErrorPago('');

        document.querySelectorAll('.pay-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.metodo === String(metodo));
        });

        // Sólo el efectivo necesita cambio, sólo el mixto necesita repartir y
        // sólo el QR necesita la referencia del comprobante.
        document.getElementById('pay-panel-efectivo')
            .classList.toggle('hide', metodo !== EFECTIVO);
        document.getElementById('pay-panel-mixto')
            .classList.toggle('hide', metodo !== 'mixto');
        document.getElementById('pay-panel-qr')
            .classList.toggle('hide', metodo !== QR);

        if (metodo === 'mixto') reiniciarLineasPago();
        if (metodo === QR) prepararPanelQr();
    }

    // ==========================================
    // COBRO POR QR
    // ==========================================
    // Este sistema NO emite el QR ni comprueba con el banco si el pago entró:
    // no tiene credenciales ni conexión durante el evento. El cajero enseña el
    // código de su propia banca móvil, mira el comprobante del cliente y teclea
    // la referencia, que es lo que después permite cuadrar la caja contra el
    // extracto bancario.
    function prepararPanelQr() {
        document.getElementById('qr-cobro-monto').textContent = orderTotal.toFixed(2) + ' Bs.';
        document.getElementById('pay-referencia').value = '';
    }

    // ---- Pago mixto en líneas libres ----
    //
    // Cualquier método se puede mezclar con cualquier otro, y tantas veces como
    // haga falta: tres personas pagando la misma comanda con tarjeta, QR y
    // efectivo es un caso normal en una barra, y antes no cabía.

    const sumaLineas = () =>
        round2(lineasPago.reduce((t, l) => t + (parseFloat(l.monto) || 0), 0));

    function pintarLineasPago() {
        payLineas.innerHTML = '';

        lineasPago.forEach((linea, i) => {
            const fila = document.createElement('div');
            fila.className = 'pay-linea';

            const select = document.createElement('select');
            select.className = 'pay-input';
            Object.keys(METODOS).forEach(id => {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = METODOS[id].nombre;
                if (Number(id) === Number(linea.metodo)) opt.selected = true;
                select.appendChild(opt);
            });
            select.addEventListener('change', () => {
                lineasPago[i].metodo = Number(select.value);
                refrescarMixto();
            });

            const monto = document.createElement('input');
            monto.type = 'number';
            monto.className = 'pay-input';
            monto.min = '0';
            monto.step = '0.01';
            monto.inputMode = 'decimal';
            monto.placeholder = '0.00';
            monto.value = linea.monto === '' ? '' : linea.monto;
            monto.addEventListener('input', () => {
                lineasPago[i].monto = monto.value;
                refrescarMixto();
            });

            fila.appendChild(select);
            fila.appendChild(monto);

            // La primera línea no se puede quitar: sin ninguna no hay pago.
            if (lineasPago.length > 1) {
                const quitar = document.createElement('button');
                quitar.type = 'button';
                quitar.className = 'pay-linea-quitar';
                quitar.textContent = '✕';
                quitar.title = 'Quitar esta forma de pago';
                quitar.addEventListener('click', () => {
                    lineasPago.splice(i, 1);
                    pintarLineasPago();
                    refrescarMixto();
                });
                fila.appendChild(quitar);
            }

            payLineas.appendChild(fila);
        });
    }

    function actualizarColorTotalPago() {
        const el = document.getElementById('pay-total');
        if (!el) return;

        el.classList.remove('status-rojo', 'status-verde', 'status-amarillo');

        if (metodoActivo === EFECTIVO) {
            if (!payRecibidoInput || payRecibidoInput.value === '' || efectivoRecibido <= 0) {
                el.classList.add('status-rojo');
            } else if (Math.abs(efectivoRecibido - orderTotal) < 0.005) {
                el.classList.add('status-verde');
            } else if (efectivoRecibido > orderTotal) {
                el.classList.add('status-amarillo');
            } else {
                el.classList.add('status-rojo');
            }
        } else if (metodoActivo === 'mixto') {
            const suma = sumaLineas();
            if (Math.abs(suma - orderTotal) < 0.005) {
                el.classList.add('status-verde');
            } else if (suma > orderTotal) {
                el.classList.add('status-amarillo');
            } else {
                el.classList.add('status-rojo');
            }
        } else {
            // Pagos exactos directos (QR, Tarjeta, Transferencia)
            el.classList.add('status-verde');
        }
    }

    function refrescarMixto() {
        const falta = round2(orderTotal - sumaLineas());
        const caja = document.getElementById('pay-falta');

        caja.textContent = Math.abs(falta).toFixed(2) + ' Bs.';
        caja.classList.toggle('pay-falta-ok', Math.abs(falta) < 0.005);
        caja.previousElementSibling.textContent =
            falta < -0.005 ? 'Cambio a devolver' : 'Falta por cubrir';

        mostrarErrorPago('');
        actualizarColorTotalPago();
    }

    function reiniciarLineasPago() {
        // Dos líneas de salida: la primera con el total entero en efectivo, que
        // es el reparto más común, y la segunda vacía para el resto.
        lineasPago = [
            { metodo: EFECTIVO, monto: '' },
            { metodo: QR, monto: '' }
        ];
        pintarLineasPago();
        refrescarMixto();
    }

    function renderCambio(destacar) {
        const caja = document.getElementById('pay-change-box');
        const valor = document.getElementById('pay-change-amount');
        const cambio = round2(efectivoRecibido - orderTotal);

        actualizarColorTotalPago();

        if (efectivoRecibido > 0 && cambio > 0) {
            valor.textContent = `${cambio.toFixed(2)} Bs.`;
            caja.classList.remove('hide');
            if (destacar) {
                caja.classList.remove('change-pop');
                void caja.offsetWidth;   // reinicia la animación si se repite
                caja.classList.add('change-pop');
            }
        } else {
            caja.classList.add('hide');
        }
    }

    // Identificador de ESTE intento de cobro. Se genera al abrir el modal y se
    // mantiene mientras el carrito sea el mismo, de modo que si hay que
    // reintentar —porque se perdió la respuesta— el servidor reconozca que es
    // la misma venta y no la guarde otra vez. Sólo cambia cuando la venta se
    // cierra de verdad y empieza una nueva.
    let claveCobro = null;

    function nuevaClaveCobro() {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
        // Respaldo para navegadores viejos: hora + azar basta para no repetirse
        // dentro de una misma barra.
        return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    }

    function abrirModalCobro() {
        if (cart.length === 0 || orderTotal <= 0) return;

        if (!claveCobro) claveCobro = nuevaClaveCobro();
        efectivoRecibido = 0;
        payRecibidoInput.value = '';
        lineasPago = [];
        mostrarErrorPago('');
        document.getElementById('pay-total').textContent = `${orderTotal.toFixed(2)} Bs.`;
        seleccionarMetodo(EFECTIVO);
        renderCambio();
        actualizarColorTotalPago();
        payModal.classList.remove('hide');
    }

    function cerrarModalCobro() {
        payModal.classList.add('hide');
    }

    // Quick cash buttons listeners
    document.querySelectorAll('.quick-cash-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.cash;
            if (val === 'exacto') {
                efectivoRecibido = orderTotal;
                payRecibidoInput.value = '';
            } else {
                efectivoRecibido = parseFloat(val) || 0;
                payRecibidoInput.value = val;
            }
            renderCambio(true);
            mostrarErrorPago('');
        });
    });

    // Split mixto panel listeners
    const payMixtoEf = document.getElementById('pay-mixto-efectivo');
    const payMixtoResto = document.getElementById('pay-mixto-resto');
    const payMixtoMetodo = document.getElementById('pay-mixto-metodo');
    const payMixtoRestoLabel = document.getElementById('pay-mixto-resto-label');

    function actualizarLabelMixto() {
        if (!payMixtoMetodo || !payMixtoRestoLabel) return;
        const val = payMixtoMetodo.value;
        const nombre = (METODOS[val] || {}).nombre || 'QR';
        payMixtoRestoLabel.textContent = 'Falta en ' + (nombre.includes('QR') ? 'QR' : nombre);
    }

    if (payMixtoMetodo) {
        payMixtoMetodo.addEventListener('change', actualizarLabelMixto);
    }

    if (payMixtoEf) {
        payMixtoEf.addEventListener('input', () => {
            const val = parseFloat(payMixtoEf.value);
            if (isNaN(val)) {
                if (payMixtoResto) payMixtoResto.value = orderTotal.toFixed(2);
                mostrarErrorPago('');
                return;
            }
            if (val > orderTotal) {
                mostrarErrorPago('El efectivo supera el total.');
            } else {
                mostrarErrorPago('');
                const falta = Math.max(0, round2(orderTotal - val));
                if (payMixtoResto) payMixtoResto.value = falta.toFixed(2);
            }
        });
    }

    function seleccionarMetodo(metodo) {
        metodoActivo = metodo;
        mostrarErrorPago('');

        document.querySelectorAll('.pay-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.metodo === String(metodo));
        });

        // Sólo el efectivo necesita cambio, sólo el mixto necesita repartir y
        // sólo el QR necesita la referencia del comprobante.
        document.getElementById('pay-panel-efectivo')
            .classList.toggle('hide', metodo !== EFECTIVO);
        document.getElementById('pay-panel-mixto')
            .classList.toggle('hide', metodo !== 'mixto');
        document.getElementById('pay-panel-qr')
            .classList.toggle('hide', metodo !== QR);

        if (metodo === 'mixto') {
            if (payMixtoEf) {
                payMixtoEf.value = '';
                if (payMixtoResto) payMixtoResto.value = orderTotal.toFixed(2);
                actualizarLabelMixto();
            }
            reiniciarLineasPago();
        }
        if (metodo === QR) prepararPanelQr();
        actualizarColorTotalPago();
    }

    // Traduce lo elegido en el modal a la lista de pagos que espera el servidor.
    function construirPagos() {
        const referencia = id => {
            const meta = METODOS[id] || { ref: 'PAGO' };
            const anotada = document.getElementById('pay-referencia').value.trim();
            if (id === QR && anotada) return anotada.slice(0, 40);
            return meta.ref + '-' + Math.floor(100000 + Math.random() * 900000);
        };
        const pago = (id, monto) => ({
            id_metodo_pago: id,
            nombre_metodo: (METODOS[id] || {}).nombre || 'Pago',
            monto: round2(monto),
            referencia: referencia(id)
        });

        if (metodoActivo !== 'mixto') {
            if (metodoActivo === EFECTIVO && efectivoRecibido > 0 &&
                efectivoRecibido + 0.005 < orderTotal) {
                mostrarErrorPago('Con ' + efectivoRecibido.toFixed(2) + ' Bs. no alcanza: ' +
                    'faltan ' + round2(orderTotal - efectivoRecibido).toFixed(2) + ' Bs.');
                return null;
            }
            return [pago(metodoActivo, orderTotal)];
        }

        // Mixto: soporte para campos split (efectivo + resto) y múltiples líneas
        if (payMixtoEf && payMixtoEf.value !== '') {
            const ef = round2(parseFloat(payMixtoEf.value) || 0);
            if (ef > orderTotal + 0.005) {
                mostrarErrorPago('El efectivo supera el total.');
                return null;
            }
            const metodoResto = Number(payMixtoMetodo ? payMixtoMetodo.value : 3) || 3;
            const resto = round2(orderTotal - ef);
            if (ef > 0 && resto > 0) {
                return [pago(EFECTIVO, ef), pago(metodoResto, resto)];
            }
        }

        const conImporte = lineasPago
            .map(l => ({ metodo: Number(l.metodo), monto: round2(parseFloat(l.monto) || 0) }))
            .filter(l => l.monto > 0);

        if (conImporte.length === 0) {
            mostrarErrorPago('Escribe cuánto se paga en cada forma de pago.');
            return null;
        }

        const suma = round2(conImporte.reduce((t, l) => t + l.monto, 0));
        if (suma + 0.005 < orderTotal) {
            mostrarErrorPago('Faltan ' + round2(orderTotal - suma).toFixed(2) + ' Bs. para cubrir el total.');
            return null;
        }
        if (suma > orderTotal + 0.005) {
            mostrarErrorPago('Los pagos suman ' + suma.toFixed(2) + ' Bs. y el total es ' + orderTotal.toFixed(2) + ' Bs.');
            return null;
        }

        return conImporte.map(l => pago(l.metodo, l.monto));
    }

    // ---- Interacciones del modal ----
    document.querySelectorAll('.pay-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const m = tab.dataset.metodo;
            seleccionarMetodo(m === 'mixto' ? 'mixto' : Number(m));
        });
    });

    payRecibidoInput.addEventListener('input', () => {
        efectivoRecibido = round2(parseFloat(payRecibidoInput.value) || 0);
        renderCambio();
        mostrarErrorPago('');
    });

    document.getElementById('pay-add-linea').addEventListener('click', () => {
        // La nueva línea nace con lo que falte: es lo que el cajero iba a
        // teclear de todas formas, y así no resta de cabeza.
        const falta = round2(orderTotal - sumaLineas());
        lineasPago.push({ metodo: EFECTIVO, monto: falta > 0 ? falta.toFixed(2) : '' });
        pintarLineasPago();
        refrescarMixto();
    });

    document.getElementById('pay-close-btn').addEventListener('click', cerrarModalCobro);
    payModal.addEventListener('click', e => {
        if (e.target === payModal) cerrarModalCobro();
    });

    // FINALIZATION & CHECKOUT SUBMIT
    // Una comanda tarda unas décimas en guardarse. Sin este cerrojo, dos toques
    // seguidos en una pantalla que no ha respondido todavía mandan la venta dos
    // veces: se cobra una y se descuenta el stock dos. El botón se queda en
    // "Guardando..." hasta que el servidor contesta.
    let guardandoComanda = false;

    // El botón del carrito ya no cobra: abre el modal donde se elige el pago.
    document.getElementById('finalize-order-btn').addEventListener('click', abrirModalCobro);

    document.getElementById('pay-confirm-btn').addEventListener('click', async () => {
        if (cart.length === 0 || orderTotal <= 0) return;
        if (guardandoComanda) return;

        // Se arma la lista de pagos antes de bloquear nada: si los montos no
        // cuadran, el modal se queda abierto con el motivo escrito.
        const pagos = construirPagos();
        if (!pagos) return;
        payments = pagos;

        const boton = document.getElementById('pay-confirm-btn');
        const etiquetaOriginal = boton.textContent;
        guardandoComanda = true;
        boton.disabled = true;
        boton.classList.add('is-busy');
        boton.textContent = 'COBRANDO...';

        const restaurarBoton = () => {
            guardandoComanda = false;
            boton.disabled = false;
            boton.classList.remove('is-busy');
            boton.textContent = etiquetaOriginal;
        };

        const observaciones = document.getElementById('cart-observations').value;

        const bodyData = {
            id_evento: currentUser.id_evento,
            id_barra: currentUser.id_barra,
            id_cajero: currentUser.id_cajero,
            id_mesero: currentWaiter.id_mesero,
            total: orderTotal,
            observaciones,
            // Los paquetes viajan aparte y sólo con su id: el contenido y el
            // precio los pone el servidor leyéndolos de la base. Si viajaran
            // desde aquí, bastaría con retocar la petición para inventarse un
            // combo de un whisky por un boliviano.
            promociones: cart.filter(c => c.tipo === 'promo').map(c => ({
                id_promocion: c.id_promocion,
                cantidad: c.cantidad
            })),
            items: cart.filter(c => c.tipo !== 'promo').map(c => ({
                id_producto: c.id_producto,
                cantidad: c.cantidad,
                precio_unitario: c.precio_venta,
                subtotal: c.precio_venta * c.cantidad,
                // Sólo el id: el precio del acompañante lo pone el servidor, y
                // es cero. Si viajara desde aquí, bastaría con retocar la
                // petición para regalarse una botella.
                // Cantidades POR BOTELLA: el servidor las multiplica por las
                // unidades de la línea. Sólo viajan ids y cantidades; el precio
                // (cero) lo pone él.
                acompanantes: (c.acompanantes || []).map(a => ({
                    id_producto: a.id_producto, cantidad: a.cantidad
                }))
            })),
            metodos_pago: payments,
            // Marca este intento de cobro. Si hay que reintentar, viaja la misma
            // y el servidor devuelve la comanda ya guardada en vez de crear otra.
            clave_idempotencia: claveCobro
        };

        try {
            const response = await fetch('/api/comanda', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyData)
            });
            const result = await response.json();

            if (result.success) {
                cerrarModalCobro();
                // El servidor recalcula precios y total desde la base de datos:
                // el ticket se imprime con esos valores, no con los del navegador.
                triggerThermalPrint(result.id_comanda, Object.assign({}, bodyData, {
                    total: typeof result.total === 'number' ? result.total : bodyData.total,
                    items: (result.items && result.items.length) ? result.items : bodyData.items,
                    // Los paquetes ya montados por el servidor, con su precio
                    // cerrado y su contenido: el ticket los imprime como una
                    // unidad en vez de sacar los precios repartidos, que en el
                    // papel no significarían nada para nadie.
                    promociones: result.promociones || [],
                    recibido: metodoActivo === EFECTIVO ? efectivoRecibido : 0
                }));
                // La venta se cerró: la próxima empieza con clave nueva.
                claveCobro = null;
                if (result.repetida) {
                    notify('Esa venta ya estaba guardada como ' +
                        (result.ref_comanda || refComanda(result.id_comanda)) +
                        '. No se cobró ni se descontó dos veces.', 'warn', 8000);
                } else {
                    anotarEnElTurno(typeof result.total === 'number' ? result.total : bodyData.total);
                    notify('Comanda ' + (result.ref_comanda || refComanda(result.id_comanda)) + ' guardada.', 'ok');
                }
                // Otra tablet puede haber vendido mientras tanto: se releen las
                // existencias para no ofrecer lo que ya no queda.
                refrescarStock();
            } else {
                notify(result.message || 'No se pudo guardar la comanda.', 'error');
                // Si el rechazo fue por existencias, el carrito está pidiendo algo
                // que otra tablet ya vendió: hay que releer el stock o el cajero
                // reintentaría en bucle contra el mismo error.
                if (/stock/i.test(result.message || '')) refrescarStock();
            }
        } catch (err) {
            // Puede que la venta SÍ se guardara y sea la respuesta la que se
            // perdió. Decir "no se guardó" a secas llevaría a cobrar dos veces.
            notify('Se perdió la conexión al cobrar. Comprueba en el panel de admin ' +
                   'si la comanda se guardó ANTES de volver a cobrarla.', 'error', 12000);
        } finally {
            restaurarBoton();
        }
    });

    // ==========================================
    // 4. VISTA PREVIA E IMPRESIÓN TÉRMICA (RawBT)
    // ==========================================
    // La vista previa se genera con el mismo maquetado que se manda a la
    // impresora (ver rawbt.js), así que lo que se ve es lo que sale impreso.
    let isReprinting = false;
    let currentTicket = null;   // modelo del ticket que se está mostrando

    /**
     * Traduce una venta —recién cerrada o recuperada del historial— al modelo
     * único de ticket que consumen la vista previa y la impresora.
     */
    function buildTicketModel(id_comanda, data) {
        const fecha = data.fecha_hora ? new Date(data.fecha_hora) : new Date();
        // Formato fijo dd/mm/aaaa hh:mm. toLocaleString() mete los segundos y
        // una coma, que en 32 columnas de papel sólo estorban.
        const dosCifras = n => String(n).padStart(2, '0');
        const hhmm = dosCifras(fecha.getHours()) + ':' + dosCifras(fecha.getMinutes());
        const ddmmaaaa = dosCifras(fecha.getDate()) + '/' + dosCifras(fecha.getMonth() + 1) +
            '/' + fecha.getFullYear();

        return {
            id: id_comanda,
            ref: data.ref_comanda || refComanda(id_comanda),
            instancia: data.instancia || instancia.nombre,
            // Se rellenan al enviar a la impresora, no aquí: hasta que el papel
            // no sale por segunda vez, esto no es una reimpresión.
            reimpresion: false,
            numeroCopia: 1,
            fecha: ddmmaaaa + ' ' + hhmm,
            // Separadas además de juntas: el ticket las coloca en las dos
            // puntas de la misma línea, y el de barra sólo usa la hora.
            fechaDia: ddmmaaaa,
            hora: hhmm,
            // El nombre del evento encabeza el ticket. Sale de Datos del
            // evento, igual que la barra.
            evento: configEvento.evento || '',
            // La barra del ticket sale de los datos del evento, que es lo que
            // el encargado escribió para esta barra; si no hay nada, se cae a
            // la barra del cajero.
            barra: configEvento.barra || data.nombre_barra ||
                   (currentUser ? currentUser.nombre_barra : 'Barra'),
            cajero: data.nombre_cajero || (currentUser ? currentUser.nombre : 'Cajero'),
            mesero: data.nombre_mesero || (currentWaiter ? currentWaiter.nombre : 'Mesero'),
            total: Number(data.total) || 0,
            // Efectivo que entregó el cliente. Sólo sirve para imprimir el
            // cambio: en la base se guarda lo cobrado, no el billete.
            recibido: Number(data.recibido) || 0,
            observaciones: data.observaciones || 'Sin observaciones',
            // Los paquetes, cada uno con su precio cerrado y lo que hay que
            // servir. Van aparte de items a propósito.
            promociones: (data.promociones || []).map(pr => ({
                nombre: pr.nombre,
                cantidad: Number(pr.cantidad) || 1,
                precio_unitario: Number(pr.precio_unitario) || 0,
                subtotal: Number(pr.subtotal) || 0,
                contenido: (pr.contenido || []).map(c => ({
                    nombre: c.nombre, cantidad: Number(c.cantidad) || 0
                }))
            })),
            // Las líneas que salieron de un paquete NO se imprimen sueltas: ya
            // van dentro de su paquete, arriba. Si se imprimieran las dos
            // cosas, el ticket cobraría el combo dos veces a la vista del
            // cliente —el importe sería correcto, pero nadie lo creería— y
            // además saldrían con los precios repartidos (29.58, 15.21), que
            // en el papel no significan nada.
            items: (data.items || []).filter(item => !item.id_promocion).map(item => {
                const known = products.find(p => p.id_producto === item.id_producto);
                return {
                    cantidad: item.cantidad,
                    nombre: item.nombre || (known ? known.nombre : 'Producto'),
                    // El ticket imprime el precio unitario, así que si la venta no
                    // lo trae se deduce del subtotal en vez de dejarlo en blanco.
                    precio_unitario: item.precio_unitario != null
                        ? Number(item.precio_unitario)
                        : (known ? Number(known.precio_venta) : null),
                    subtotal: Number(item.subtotal) || 0,
                    // El acompañante viaja DENTRO de su línea, no como línea
                    // aparte: el ticket lo imprime sangrado debajo y sin
                    // importe, que es como se entiende que va incluido.
                    acompanantes: item.acompanantes
                        ? item.acompanantes.map(a => ({ nombre: a.nombre, cantidad: a.cantidad }))
                        : (item.acomps || []).map(a => ({ nombre: a.nombre, cantidad: a.qty }))
                };
            }),
            pagos: (data.metodos_pago || payments).map(pay => {
                const metodo = pay.nombre_metodo || pay.nombre || 'Pago';
                // La referencia arranca con el método (EFECTIVO-CAJA-123456). Sólo
                // se añade cuando aporta algo: repetir "Efectivo (EFECTIVO)" no.
                const cabeza = pay.referencia ? String(pay.referencia).split('-')[0] : '';
                const prefijo = cabeza && cabeza.toLowerCase() !== metodo.toLowerCase()
                    ? ' (' + cabeza + ')'
                    : '';
                return { etiqueta: metodo + prefijo, monto: Number(pay.monto) || 0 };
            })
        };
    }

    function setPrintStatus(text, kind) {
        const boxes = [document.getElementById('print-status'), document.getElementById('modal-print-status')];
        boxes.forEach(box => {
            if (!box) return;
            if (!text) {
                box.className = 'print-status hide';
                box.textContent = '';
                return;
            }
            box.textContent = text;
            box.className = 'print-status ' + (kind || 'info');
        });
    }

    // Deja constancia de cada impresión física en impresion_comanda_*.
    // Es informativo: si falla, la impresión igual se hizo.
    function logPrint(id_comanda) {
        if (!Number.isInteger(Number(id_comanda))) return;

        // Van los DOS responsables, no sólo quien tocó la pantalla: si el
        // cajero y el mesero se coordinan para reimprimir y cobrar aparte, con
        // un solo nombre apuntado el otro no aparece por ningún lado.
        const responsables = {
            id_cajero: currentUser ? currentUser.id_cajero : null,
            id_mesero: currentWaiter ? currentWaiter.id_mesero : null
        };

        ['cajero', 'mesero'].forEach(tipo => {
            enviarApunte(Object.assign({ id_comanda, tipo }, responsables));
        });
    }

    // El apunte tiene que llegar aunque la tablet se vaya a segundo plano.
    //
    // Abrir RawBT saca al navegador de primer plano, y Android/Chrome cancelan
    // los fetch que estén a medias: el registro se perdía justo al reimprimir,
    // que es cuando más falta hace. Se veía sólo en la tablet, porque en un PC
    // no hay app externa a la que saltar.
    //
    // sendBeacon está pensado exactamente para esto: el navegador se
    // compromete a entregarlo aunque la página deje de estar activa.
    function enviarApunte(cuerpo) {
        const datos = JSON.stringify(cuerpo);

        if (navigator.sendBeacon) {
            try {
                const enviado = navigator.sendBeacon('/api/impresion',
                    new Blob([datos], { type: 'application/json' }));
                if (enviado) return;
            } catch (err) { /* se cae al fetch de abajo */ }
        }

        // keepalive hace lo mismo que sendBeacon para navegadores que no lo
        // tengan: la petición sigue viva aunque la página se vaya.
        fetch('/api/impresion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: datos,
            keepalive: true
        }).catch(err => console.warn('No se pudo registrar la impresión:', err));
    }

    function renderTicketPreview(model) {
        const settings = ThermalPrinter.getSettings();
        const tCajero = document.getElementById('ticket-cajero-body');
        const tMesero = document.getElementById('ticket-mesero-body');
        if (!tCajero || !tMesero) return;

        if (!model) {
            const vacio = '<p class="ticket-vacio" style="text-align:center; padding: 20px; color:var(--text-muted);">Aquí se verá la comanda cuando cobres.</p>';
            tCajero.innerHTML = vacio;
            tMesero.innerHTML = vacio;
            return;
        }

        const tickets = ThermalPrinter.buildTickets(model, settings);
        tCajero.innerHTML = ThermalPrinter.helpers.opsToHtml(tickets.cajero, settings);
        tMesero.innerHTML = ThermalPrinter.helpers.opsToHtml(tickets.mesero, settings);
    }

    function marcarSiguienteComoReimpresion() {
        if (!currentTicket) return;
        currentTicket.numeroCopia = (currentTicket.numeroCopia || 1) + 1;
        currentTicket.reimpresion = true;
        renderTicketPreview(currentTicket);
    }

    function sendToPrinter() {
        if (!currentTicket) return;
        const esCopia = Boolean(currentTicket.reimpresion);

        // El registro de reimpresión solo se hace si es una copia extra (reimpresión).
        // La copia original (#1) ya queda registrada en el backend al crear la comanda.
        if (esCopia) {
            logPrint(currentTicket.id);
        }

        try {
            ThermalPrinter.printToRawBT(currentTicket);
            notify(esCopia ? 'Reimpresión enviada a la impresora.'
                           : 'Comanda enviada a la impresora.', 'ok');
            setPrintStatus('Enviado a RawBT. Si no imprime nada, revisa ⚙️ Impresora.', 'ok');
        } catch (err) {
            console.error('Error al enviar a RawBT:', err);
            notify('No se pudo abrir RawBT. ¿Está instalado en la tablet? ' +
                   'La venta SÍ quedó guardada.', 'error');
            setPrintStatus('No se pudo abrir RawBT. ¿Está instalado en la tablet?', 'error');
        }
    }

    // Muestra la vista previa de los tickets (Cajero y Mesero) y manda la impresión
    function triggerThermalPrint(id_comanda, data, fromAdmin = false) {
        isReprinting = fromAdmin;
        currentTicket = buildTicketModel(id_comanda, data);
        window.ultimoTicket = currentTicket;

        if (fromAdmin) {
            currentTicket.reimpresion = true;
            currentTicket.numeroCopia = 2;
            renderTicketPreview(currentTicket);
            setPrintStatus('');

            const printModal = document.getElementById('print-modal');
            if (printModal) {
                printModal.classList.remove('hide');
            }
            sendToPrinter();
        } else {
            // Venta normal en POS: impresión automática sin modal de previsualización
            renderTicketPreview(currentTicket);
            sendToPrinter();
            volverAlBloqueoDeMesero();
        }
    }

    function cerrarVistaPreviaTicket() {
        const printModal = document.getElementById('print-modal');
        if (printModal) {
            printModal.classList.add('hide');
        }
        currentTicket = null;

        if (isReprinting) {
            isReprinting = false;
        } else {
            volverAlBloqueoDeMesero();
        }
    }

    const dismissPrintBtn = document.getElementById('dismiss-print-btn');
    if (dismissPrintBtn) {
        dismissPrintBtn.addEventListener('click', cerrarVistaPreviaTicket);
    }

    const closePrintModalBtn = document.getElementById('close-print-modal-btn');
    if (closePrintModalBtn) {
        closePrintModalBtn.addEventListener('click', cerrarVistaPreviaTicket);
    }

    const printRawbtBtn = document.getElementById('print-rawbt-btn');
    if (printRawbtBtn) {
        printRawbtBtn.addEventListener('click', () => {
            if (!currentTicket) return;
            sendToPrinter();
            marcarSiguienteComoReimpresion();
        });
    }

    const printBrowserBtn = document.getElementById('print-browser-btn');
    if (printBrowserBtn) {
        printBrowserBtn.addEventListener('click', () => {
            if (!currentTicket) return;
            if (currentTicket.reimpresion) {
                logPrint(currentTicket.id);
            }
            ThermalPrinter.printViaBrowser(currentTicket);
            marcarSiguienteComoReimpresion();
        });
    }

    function volverAlBloqueoDeMesero() {
        currentWaiter = null;
        vaciarCarrito();
        posView.classList.add('hide');
        showWaiterModal();
    }

    // ---- Panel de configuración de impresora ----
    const printerSettingsPanel = document.getElementById('printer-settings');

    const settingsFields = {
        'cfg-width':    { key: 'width',     parse: v => parseInt(v, 10) },
        'cfg-encoding': { key: 'encoding',  parse: v => v },
        'cfg-mode':     { key: 'mode',      parse: v => v },
        'cfg-single':   { key: 'singleJob', parse: v => v === '1' },
        'cfg-cut':      { key: 'cut',       parse: v => v === '1' }
    };

    function loadPrinterSettingsIntoForm() {
        const settings = ThermalPrinter.getSettings();
        Object.keys(settingsFields).forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const value = settings[settingsFields[id].key];
            el.value = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
        });
    }

    Object.keys(settingsFields).forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', e => {
                const field = settingsFields[id];
                ThermalPrinter.saveSettings({ [field.key]: field.parse(e.target.value) });
                if (currentTicket) renderTicketPreview(currentTicket);
            });
        }
    });

    // Configurar la impresora antes de la primera venta del evento.
    //
    // Antes esto imprimía una comanda de prueba con productos y un total
    // inventados. Un ticket así, encima de la barra a las dos de la mañana, no
    // se distingue de uno real: se prestaba a cobrarlo.
    loadPrinterSettingsIntoForm();

    // ==========================================
    // 5. ADMINISTRATOR PANEL CONTROLLER
    // ==========================================
    function showAdminView() {
        detenerSondeoStock();
        cargarConfiguracion().then(pintarConfiguracion);
        cargarInfoAficheAdmin();
        loginView.classList.add('hide');
        posView.classList.add('hide');
        adminView.classList.remove('hide');

        const esEncargado = (
            currentUser.rol === 'ENCARGADO' ||
            currentUser.rol === 'ENCARGADO_STOCK' ||
            currentUser.rol === 'ENCARGADO_INVENTARIO' ||
            currentUser.rol === 'ENCARGA'
        );

        const badgeEl = document.getElementById('admin-role-badge');
        if (badgeEl) badgeEl.textContent = esEncargado ? 'ENCARGADO' : currentUser.rol;

        const brandingH2 = document.querySelector('#admin-view .admin-branding h2');
        if (brandingH2) brandingH2.textContent = esEncargado ? 'Inventario' : 'Panel Admin';

        const userNameEl = document.getElementById('admin-user-name');
        if (userNameEl) userNameEl.textContent = currentUser.nombre;

        // Filtrar y mostrar SOLO el módulo de Inventario si es Encargado
        document.querySelectorAll('.nav-tab-btn').forEach(btn => {
            const t = btn.getAttribute('data-tab');
            if (esEncargado) {
                // El encargado SOLO ve el módulo de Inventario (tab-stock)
                if (t === 'tab-stock') {
                    btn.style.display = '';
                } else {
                    btn.style.display = 'none';
                }
            } else {
                btn.style.display = '';
            }
            btn.classList.remove('active');
        });

        document.querySelectorAll('.tab-content').forEach(tc => tc.classList.add('hide'));

        if (esEncargado) {
            // Mostrar directamente la pestaña de Inventario
            const stockBtn = document.querySelector('[data-tab="tab-stock"]');
            if (stockBtn) stockBtn.classList.add('active');
            const stockContent = document.getElementById('tab-stock');
            if (stockContent) stockContent.classList.remove('hide');
            loadStockSetup();
        } else {
            // Admin normal
            const dashBtn = document.querySelector('[data-tab="tab-dashboard"]');
            if (dashBtn) dashBtn.classList.add('active');
            const dashContent = document.getElementById('tab-dashboard');
            if (dashContent) dashContent.classList.remove('hide');
            loadDashboardData();
            loadPersonalSetup();
            cargarPersonalAdmin();
            loadCatalogSetup();
            cargarCatalogoAdmin();
        }
    }

    // Setup Admin Navigation Tab listeners
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const targetTab = btn.getAttribute('data-tab');
            document.querySelectorAll('.tab-content').forEach(tc => tc.classList.add('hide'));
            document.getElementById(targetTab).classList.remove('hide');

            const adminMain = document.querySelector('#admin-view .admin-main');
            if (adminMain) adminMain.scrollTop = 0;

            // Load data according to tab
            if (targetTab === 'tab-dashboard') loadDashboardData();
            else if (targetTab === 'tab-comandas') loadComandasData();
            else if (targetTab === 'tab-crear-producto') { loadCatalogSetup(); cargarCatalogoAdmin(); }
            else if (targetTab === 'tab-promociones') { cargarCatalogoAdmin().then(pintarSelectorProductos); cargarPromociones(); }
            else if (targetTab === 'tab-crear-personal') { loadPersonalSetup(); cargarPersonalAdmin(); }
            else if (targetTab === 'tab-stock') loadStockSetup();
            else if (targetTab === 'tab-inventario') loadInventoryData();
            else if (targetTab === 'tab-reimpresiones') loadReimpresionesData();
            else if (targetTab === 'tab-auditoria') loadAuditsData();
            else if (targetTab === 'tab-configuracion') { cargarConfiguracion().then(pintarConfiguracion); cargarInfoAficheAdmin(); loadPrinterSettingsIntoForm(); }
        });
    });

    // TAB: REIMPRESIONES
    let allReimpresiones = [];
    let filteredReimpresiones = [];
    let reimpresionesPage = 1;
    const reimpresionesLimit = 14;
    let reimpresionesFilterSearch = '';
    let reimpresionesFilterCajero = 'all';
    let reimpresionesFilterCopia = 'all';
    let reimpresionesFilterSort = 'fecha_desc';
    let reimpresionesFiltersInitialized = false;

    async function loadReimpresionesData() {
        const cuerpo = document.getElementById('reimpresiones-table-body');
        if (cuerpo) cuerpo.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px; color: #71717a; font-weight: 600;">Cargando reimpresiones...</td></tr>';
        
        try {
            const res = await fetch('/api/admin/reimpresiones');
            const data = await res.json();
            allReimpresiones = data.reimpresiones || [];

            // Llenar selector de cajeros únicos
            const cajeroSelect = document.getElementById('reimpresiones-filter-cajero');
            if (cajeroSelect) {
                const currentVal = cajeroSelect.value || 'all';
                const cajerosUnicos = [...new Set(allReimpresiones.map(r => r.cajero).filter(Boolean))].sort();
                cajeroSelect.innerHTML = '<option value="all">Todos los cajeros</option>';
                cajerosUnicos.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c;
                    opt.textContent = c;
                    cajeroSelect.appendChild(opt);
                });
                cajeroSelect.value = currentVal;
            }

            initReimpresionesFilterListeners();
            applyReimpresionesFilters();
        } catch (err) {
            console.error('Error al cargar las reimpresiones:', err);
            if (cuerpo) cuerpo.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px; color: #ef4444; font-weight: 600;">No se pudieron cargar las reimpresiones.</td></tr>';
        }
    }

    function initReimpresionesFilterListeners() {
        if (reimpresionesFiltersInitialized) return;
        reimpresionesFiltersInitialized = true;

        const searchInput = document.getElementById('reimpresiones-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                reimpresionesFilterSearch = e.target.value;
                reimpresionesPage = 1;
                applyReimpresionesFilters();
            });
        }

        const cajeroSelect = document.getElementById('reimpresiones-filter-cajero');
        if (cajeroSelect) {
            cajeroSelect.addEventListener('change', (e) => {
                reimpresionesFilterCajero = e.target.value;
                reimpresionesPage = 1;
                applyReimpresionesFilters();
            });
        }

        const copiaSelect = document.getElementById('reimpresiones-filter-copia');
        if (copiaSelect) {
            copiaSelect.addEventListener('change', (e) => {
                reimpresionesFilterCopia = e.target.value;
                reimpresionesPage = 1;
                applyReimpresionesFilters();
            });
        }

        const sortSelect = document.getElementById('reimpresiones-filter-sort');
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                reimpresionesFilterSort = e.target.value;
                reimpresionesPage = 1;
                applyReimpresionesFilters();
            });
        }

        const clearBtn = document.getElementById('reimpresiones-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                reimpresionesFilterSearch = '';
                reimpresionesFilterCajero = 'all';
                reimpresionesFilterCopia = 'all';
                reimpresionesFilterSort = 'fecha_desc';

                if (searchInput) searchInput.value = '';
                if (cajeroSelect) cajeroSelect.value = 'all';
                if (copiaSelect) copiaSelect.value = 'all';
                if (sortSelect) sortSelect.value = 'fecha_desc';

                reimpresionesPage = 1;
                applyReimpresionesFilters();
            });
        }
    }

    function applyReimpresionesFilters() {
        const query = (reimpresionesFilterSearch || '').toLowerCase().trim();

        filteredReimpresiones = allReimpresiones.filter(r => {
            const comandaStr = '#' + r.id_comanda;
            const cajeroStr = (r.cajero || '').toLowerCase();
            const meseroStr = (r.mesero || '').toLowerCase();
            const matchSearch = !query || comandaStr.includes(query) || cajeroStr.includes(query) || meseroStr.includes(query);

            const matchCajero = (reimpresionesFilterCajero === 'all') || (r.cajero === reimpresionesFilterCajero);

            let matchCopia = true;
            if (reimpresionesFilterCopia === '1') {
                matchCopia = (Number(r.numero_reimpresion) === 1);
            } else if (reimpresionesFilterCopia === 'multi') {
                matchCopia = (Number(r.numero_reimpresion) > 1);
            }

            return matchSearch && matchCajero && matchCopia;
        });

        // Ordenamiento
        filteredReimpresiones.sort((a, b) => {
            if (reimpresionesFilterSort === 'fecha_asc') return (a.fecha || '').localeCompare(b.fecha || '');
            if (reimpresionesFilterSort === 'total_desc') return Number(b.total) - Number(a.total);
            if (reimpresionesFilterSort === 'total_asc') return Number(a.total) - Number(b.total);
            if (reimpresionesFilterSort === 'comanda_desc') return b.id_comanda - a.id_comanda;
            if (reimpresionesFilterSort === 'comanda_asc') return a.id_comanda - b.id_comanda;
            return (b.fecha || '').localeCompare(a.fecha || ''); // default fecha_desc
        });

        const summaryCount = document.getElementById('reimpresiones-summary-count');
        if (summaryCount) {
            summaryCount.innerHTML = `<strong>${allReimpresiones.length}</strong> reimpresiones en total · Mostrando <strong>${filteredReimpresiones.length}</strong> con filtros aplicados`;
        }

        renderReimpresionesPage();
    }

    function renderReimpresionesPage() {
        const cuerpo = document.getElementById('reimpresiones-table-body');
        if (!cuerpo) return;
        cuerpo.innerHTML = '';

        const totalItems = filteredReimpresiones.length;

        if (totalItems === 0) {
            if (allReimpresiones.length === 0) {
                cuerpo.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 28px; color: #10b981; font-weight: 700;">🟢 Ninguna comanda se ha reimpreso hasta ahora.</td></tr>';
            } else {
                cuerpo.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 28px; color: #71717a; font-weight: 600;">No se encontraron reimpresiones con los filtros aplicados.</td></tr>';
            }
            renderReimpresionesPagination(0, 0);
            return;
        }

        const totalPages = Math.ceil(totalItems / reimpresionesLimit) || 1;
        if (reimpresionesPage > totalPages) reimpresionesPage = totalPages;
        if (reimpresionesPage < 1) reimpresionesPage = 1;

        const start = (reimpresionesPage - 1) * reimpresionesLimit;
        const end = start + reimpresionesLimit;
        const pageItems = filteredReimpresiones.slice(start, end);

        pageItems.forEach(r => {
            const tr = document.createElement('tr');
            const num = Number(r.numero_reimpresion) || 1;
            const badgeClass = num > 1 ? 'badge-stock agotado' : 'badge-stock bajo';
            const badgeText = `${num}ª copia`;

            tr.innerHTML = `
                <td><strong>#${r.id_comanda}</strong></td>
                <td><span class="${badgeClass}">${badgeText}</span></td>
                <td><strong>${escapeHtml(r.cajero || '—')}</strong></td>
                <td>${escapeHtml(r.mesero || '—')}</td>
                <td style="font-weight: 800; color: #000000;">${Number(r.total || 0).toFixed(2)} Bs.</td>
                <td style="color: #52525b; font-size: 0.78rem;">${r.fecha || '—'}</td>
            `;
            cuerpo.appendChild(tr);
        });

        renderReimpresionesPagination(totalPages, totalItems);
    }

    function renderReimpresionesPagination(totalPages, totalItems) {
        const pagContainer = document.getElementById('reimpresiones-pagination');
        if (!pagContainer) return;

        if (totalItems === 0) {
            pagContainer.innerHTML = '<span class="comanda-pag-info">0 reimpresiones encontradas</span>';
            return;
        }

        if (totalPages <= 1) {
            pagContainer.innerHTML = `<span class="comanda-pag-info">Mostrando las <strong>${totalItems}</strong> reimpresiones</span>`;
            return;
        }

        let html = `
            <button type="button" class="comanda-pag-btn btn-prev" ${reimpresionesPage <= 1 ? 'disabled' : ''}>
                ◀ Anterior
            </button>
        `;

        const maxBotones = 5;
        let startPage = Math.max(1, reimpresionesPage - Math.floor(maxBotones / 2));
        let endPage = Math.min(totalPages, startPage + maxBotones - 1);
        if (endPage - startPage + 1 < maxBotones) {
            startPage = Math.max(1, endPage - maxBotones + 1);
        }

        if (startPage > 1) {
            html += `<button type="button" class="comanda-pag-btn btn-num" data-page="1">1</button>`;
            if (startPage > 2) html += `<span class="comanda-pag-info">...</span>`;
        }

        for (let p = startPage; p <= endPage; p++) {
            html += `<button type="button" class="comanda-pag-btn btn-num ${p === reimpresionesPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
        }

        if (endPage < totalPages) {
            if (endPage < totalPages - 1) html += `<span class="comanda-pag-info">...</span>`;
            html += `<button type="button" class="comanda-pag-btn btn-num" data-page="${totalPages}">${totalPages}</button>`;
        }

        html += `
            <button type="button" class="comanda-pag-btn btn-next" ${reimpresionesPage >= totalPages ? 'disabled' : ''}>
                Siguiente ▶
            </button>
            <span class="comanda-pag-info">(${totalItems} reimpresiones · Pág. ${reimpresionesPage}/${totalPages})</span>
        `;

        pagContainer.innerHTML = html;

        const prev = pagContainer.querySelector('.btn-prev');
        if (prev) {
            prev.addEventListener('click', () => {
                if (reimpresionesPage > 1) {
                    reimpresionesPage--;
                    renderReimpresionesPage();
                    const container = document.querySelector('#tab-reimpresiones .table-container');
                    if (container) container.scrollTop = 0;
                }
            });
        }

        const next = pagContainer.querySelector('.btn-next');
        if (next) {
            next.addEventListener('click', () => {
                if (reimpresionesPage < totalPages) {
                    reimpresionesPage++;
                    renderReimpresionesPage();
                    const container = document.querySelector('#tab-reimpresiones .table-container');
                    if (container) container.scrollTop = 0;
                }
            });
        }

        pagContainer.querySelectorAll('.btn-num').forEach(btn => {
            btn.addEventListener('click', () => {
                const p = parseInt(btn.dataset.page, 10);
                if (p && p !== reimpresionesPage) {
                    reimpresionesPage = p;
                    renderReimpresionesPage();
                    const container = document.querySelector('#tab-reimpresiones .table-container');
                    if (container) container.scrollTop = 0;
                }
            });
        });
    }

    // TAB: DASHBOARD DATA
    async function loadDashboardData() {
        try {
            const response = await fetch('/api/admin/comandas');
            const todasComandas = await response.json();
            
            // Los eventos nocturnos abarcan de un día para el otro (ayer y hoy)
            const hoy = new Date();
            const ayer = new Date(hoy);
            ayer.setDate(hoy.getDate() - 1);
            const fIso = d => d.getFullYear() + '-' +
                String(d.getMonth() + 1).padStart(2, '0') + '-' +
                String(d.getDate()).padStart(2, '0');
            const fechaMin = fIso(ayer);
            const fechaMax = fIso(hoy);

            const comandas = (Array.isArray(todasComandas) ? todasComandas : []).filter(c => {
                if (!c.fecha_hora) return true;
                const f = String(c.fecha_hora).slice(0, 10);
                return f >= fechaMin && f <= fechaMax;
            });
            
            const activeComandas = comandas.filter(c => c.estado_pago !== 'ANULADO');
            const voidedComandas = comandas.filter(c => c.estado_pago === 'ANULADO');

            const totalRecaudado = activeComandas.reduce((sum, c) => sum + parseFloat(c.total || 0), 0);

            const kpiSales = document.getElementById('kpi-total-sales');
            if (kpiSales) kpiSales.textContent = `${totalRecaudado.toFixed(2)} Bs.`;
            
            const kpiOrders = document.getElementById('kpi-total-orders');
            if (kpiOrders) kpiOrders.textContent = activeComandas.length;

            const kpiVoids = document.getElementById('kpi-voided-orders');
            if (kpiVoids) kpiVoids.textContent = voidedComandas.length;

            // 1. Group sales by cashier for progress list
            const salesByCajero = {};
            activeComandas.forEach(c => {
                const cName = (c.nombre_cajero && c.nombre_cajero.trim()) ? c.nombre_cajero : 'Cajero General';
                salesByCajero[cName] = (salesByCajero[cName] || 0) + parseFloat(c.total || 0);
            });

            const chartContainer = document.getElementById('cajeros-sales-chart') || document.getElementById('barras-sales-chart');
            if (chartContainer) {
                chartContainer.innerHTML = '';
                const cajeroNames = Object.keys(salesByCajero).sort((a, b) => salesByCajero[b] - salesByCajero[a]);
                if (cajeroNames.length === 0) {
                    chartContainer.innerHTML = '<div class="empty-cart-msg">Sin ventas registradas</div>';
                } else {
                    const cajeroColors = ['#10b981', '#6366f1', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6'];
                    cajeroNames.forEach((name, idx) => {
                        const amount = salesByCajero[name];
                        const pct = totalRecaudado > 0 ? (amount / totalRecaudado) * 100 : 0;
                        const color = cajeroColors[idx % cajeroColors.length];

                        const div = document.createElement('div');
                        div.className = 'sales-bar-item';
                        div.innerHTML = `
                            <div class="sales-bar-info">
                                <span class="sales-bar-label"><span class="chart-bullet" style="background:${color}"></span>${escapeHtml(name)}</span>
                                <strong class="sales-bar-val">${amount.toFixed(2)} Bs. <span class="sales-bar-pct">(${pct.toFixed(1)}%)</span></strong>
                            </div>
                            <div class="sales-bar-track">
                                <div class="sales-bar-fill" style="width: ${pct}%; background: ${color};"></div>
                            </div>
                        `;
                        chartContainer.appendChild(div);
                    });
                }
            }

            // 2. Group sales by payment method
            const salesByMethod = {};
            let totalPagadoMetodos = 0;
            activeComandas.forEach(c => {
                if (Array.isArray(c.pagos) && c.pagos.length > 0) {
                    c.pagos.forEach(p => {
                        const mName = (p.nombre_metodo && p.nombre_metodo.trim()) ? p.nombre_metodo : 'Otro';
                        const monto = parseFloat(p.monto || 0);
                        salesByMethod[mName] = (salesByMethod[mName] || 0) + monto;
                        totalPagadoMetodos += monto;
                    });
                } else {
                    const mName = (c.forma_pago && c.forma_pago.trim()) ? c.forma_pago : 'Efectivo';
                    const monto = parseFloat(c.total || 0);
                    salesByMethod[mName] = (salesByMethod[mName] || 0) + monto;
                    totalPagadoMetodos += monto;
                }
            });

            const methodChartContainer = document.getElementById('metodos-sales-chart');
            if (methodChartContainer) {
                methodChartContainer.innerHTML = '';
                const methodNames = Object.keys(salesByMethod).sort((a, b) => salesByMethod[b] - salesByMethod[a]);
                if (methodNames.length === 0) {
                    methodChartContainer.innerHTML = '<div class="empty-cart-msg">Sin pagos registrados</div>';
                } else {
                    const methodIcons = {
                        'Efectivo': '💵',
                        'QR': '📱',
                        'Tarjeta': '💳',
                        'Transferencia': '🏦',
                        'Cortesía': '🎁',
                        'Otro': '🪙'
                    };
                    const methodColors = {
                        'Efectivo': '#22c55e',
                        'QR': '#3b82f6',
                        'Tarjeta': '#a855f7',
                        'Transferencia': '#f97316',
                        'Cortesía': '#ec4899',
                        'Otro': '#64748b'
                    };

                    // Split visual bar
                    let splitBarHtml = '<div class="method-split-bar">';
                    methodNames.forEach((name, idx) => {
                        const amount = salesByMethod[name];
                        const pct = totalPagadoMetodos > 0 ? (amount / totalPagadoMetodos) * 100 : 0;
                        const color = methodColors[name] || ['#10b981', '#6366f1', '#f59e0b', '#ec4899'][idx % 4];
                        if (pct > 0) {
                            splitBarHtml += `<div class="method-split-segment" style="width:${pct}%; background:${color};" title="${escapeHtml(name)}: ${pct.toFixed(1)}%"></div>`;
                        }
                    });
                    splitBarHtml += '</div>';

                    const splitDiv = document.createElement('div');
                    splitDiv.innerHTML = splitBarHtml;
                    methodChartContainer.appendChild(splitDiv);

                    methodNames.forEach((name, idx) => {
                        const amount = salesByMethod[name];
                        const pct = totalPagadoMetodos > 0 ? (amount / totalPagadoMetodos) * 100 : 0;
                        const icon = methodIcons[name] || '💳';
                        const color = methodColors[name] || ['#10b981', '#6366f1', '#f59e0b', '#ec4899'][idx % 4];

                        const div = document.createElement('div');
                        div.className = 'sales-bar-item';
                        div.innerHTML = `
                            <div class="sales-bar-info">
                                <span class="sales-bar-label">${icon} ${escapeHtml(name)}</span>
                                <strong class="sales-bar-val">${amount.toFixed(2)} Bs. <span class="sales-bar-pct">(${pct.toFixed(1)}%)</span></strong>
                            </div>
                            <div class="sales-bar-track">
                                <div class="sales-bar-fill" style="width: ${pct}%; background: ${color};"></div>
                            </div>
                        `;
                        methodChartContainer.appendChild(div);
                    });
                }
            }

        } catch (err) {
            console.error("Error loading dashboard data:", err);
        }
    }

    // ==========================================
    // DATOS DEL EVENTO
    // ==========================================
    // Evento, fecha, lugar, barra y responsable. Van en la tabla
    // `configuracion` y encabezan los tickets y el reporte de cierre. Se
    // rellenan una vez por evento.
    let configEvento = { evento: '', fecha: '', lugar: '', barra: '', responsable: '' };

    async function cargarConfiguracion() {
        try {
            const res = await fetch('/api/configuracion');
            if (res.ok) {
                configEvento = await res.json();
                actualizarTituloBarra();
                if (window.ThermalPrinter && typeof window.ThermalPrinter.setLogoUrl === 'function') {
                    window.ThermalPrinter.setLogoUrl('/api/configuracion/logo?t=' + Date.now());
                }
            }
        } catch (err) {
            console.warn('No se pudo leer la configuración del evento:', err);
        }
        return configEvento;
    }

    // ------------------------------------------------------------------
    // LA FICHA DE LA PANTALLA DE CLAVE
    // ------------------------------------------------------------------
    // Los mismos datos que encabezan los tickets, puestos donde se miran mil
    // veces por noche. No es adorno: si la tablet quedó rotulada con el evento
    // de la semana pasada o con la barra de al lado, se ve aquí, antes de la
    // primera venta, y no al cerrar caja.
    const MESES_CARTEL = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN',
                          'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

    function fechaDeCartel(valor) {
        const texto = String(valor || '').trim();
        // El campo del panel es un <input type="date">, así que lo normal es
        // recibir 2026-09-12. Lo que no encaje se enseña tal cual: el día que
        // alguien escriba ahí "viernes y sábado", eso es lo que hay que leer.
        const iso = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!iso) return texto;
        return Number(iso[3]) + ' ' + MESES_CARTEL[Number(iso[2]) - 1] + ' ' + iso[1];
    }

    function pintarFichaEvento() {
        const poner = (id, texto) => {
            const el = document.getElementById(id);
            // La raya no es un adorno: deja el hueco con su alto y se ve que
            // ese dato falta por rellenar en el panel.
            if (el) el.textContent = texto || '—';
        };

        // El nombre de la barra puede venir de la configuración del evento o
        // de la identidad de la tablet; son el mismo dato por dos caminos.
        const barra = configEvento.barra || instancia.nombre || '';
        const lugar = configEvento.lugar || '';

        poner('ficha-fecha', fechaDeCartel(configEvento.fecha));
        poner('ficha-lugar', lugar);
        poner('ficha-barra', barra);
        poner('ficha-evento', configEvento.evento || 'MasterDrinks');
        poner('active-cajero-name', currentUser ? currentUser.nombre : '');

        // Sin afiche, el hueco del cartel lleva el nombre del evento.
        const vacio = document.getElementById('ficha-afiche-vacio');
        if (vacio && configEvento.evento) vacio.textContent = configEvento.evento;
    }

    // El afiche es un archivo suelto —afiche.jpg junto al servidor— y no un
    // dato de la base: se cambia una vez por evento, lo deja quien monta las
    // tablets y así no hay que entrar al panel ni subir nada. Si no está, en
    // su sitio queda el nombre del evento; nunca un icono de imagen rota.
    function cargarAfiche() {
        const img = document.getElementById('ficha-afiche-img');
        const vacio = document.getElementById('ficha-afiche-vacio');
        if (!img) return;

        img.addEventListener('load', () => {
            img.classList.remove('hide');
            if (vacio) vacio.classList.add('hide');
            pintarTemaDelAfiche(img);
        });

        // El hueco cambia de tamaño al girar la tablet, y con él la cuenta de
        // si el cartel da la talla.
        window.addEventListener('resize', ajustarCalidadDelAfiche);
        img.addEventListener('error', () => {
            img.classList.add('hide');
            if (vacio) vacio.classList.remove('hide');
        });
        img.src = '/afiche';
    }

    // ------------------------------------------------------------------
    // EL COLOR DE LA PANTALLA SALE DEL AFICHE
    // ------------------------------------------------------------------
    // De la foto del cartel se saca UN DATO: el tono dominante (y un segundo
    // tono, el del remate, para el sello de la barra). La claridad y la
    // saturación de cada pieza no salen de la foto: son las de style.css.
    //
    // Esa distinción es todo el asunto. Aquí ya hubo un analizador que
    // copiaba el color dominante tal cual, y con un fondo apagado dejó los
    // botones blancos sobre blanco, con pinta de desactivados (está contado
    // en cargarFondo). Fijando la claridad, el número siempre se lee encima
    // de su tecla y el nombre del evento encima de su papel, venga el cartel
    // que venga; lo único que cambia es de qué color es la noche.
    //
    // Si el cartel no tiene color del que fiarse —un blanco y negro, por
    // ejemplo— no se toca nada y se queda la paleta escrita en el CSS.
    const CUBOS_TONO = 24;   // el círculo de color partido en tramos de 15°

    function tonosDelAfiche(img) {
        const ancho = 64;
        const alto = Math.max(1, Math.round(ancho * (img.naturalHeight || 1) /
                                                    (img.naturalWidth || 1)));
        const lienzo = document.createElement('canvas');
        lienzo.width = ancho;
        lienzo.height = alto;

        const pincel = lienzo.getContext('2d', { willReadFrequently: true });
        pincel.drawImage(img, 0, 0, ancho, alto);
        const pixeles = pincel.getImageData(0, 0, ancho, alto).data;

        const peso = new Array(CUBOS_TONO).fill(0);
        const sumaTono = new Array(CUBOS_TONO).fill(0);

        for (let i = 0; i < pixeles.length; i += 4) {
            const r = pixeles[i] / 255, v = pixeles[i + 1] / 255, a = pixeles[i + 2] / 255;
            const alto_ = Math.max(r, v, a), bajo = Math.min(r, v, a);
            if (alto_ === bajo) continue;              // gris puro: no dice nada del tono

            const luz = (alto_ + bajo) / 2;
            const rango = alto_ - bajo;
            const sat = luz > 0.5 ? rango / (2 - alto_ - bajo) : rango / (alto_ + bajo);
            // Ni los negros del fondo ni el blanco de las letras tiñen nada.
            if (sat < 0.18 || luz < 0.10 || luz > 0.92) continue;

            let tono;
            if (alto_ === r)      tono = (v - a) / rango + (v < a ? 6 : 0);
            else if (alto_ === v) tono = (a - r) / rango + 2;
            else                  tono = (r - v) / rango + 4;
            tono *= 60;

            // Pesa más el color saturado y de claridad media: es el que se ve
            // como "el color del cartel", no la sombra ni el reflejo.
            const cuanto = sat * (1 - Math.abs(luz - 0.5) * 1.2);
            const cubo = Math.min(CUBOS_TONO - 1, Math.floor(tono / (360 / CUBOS_TONO)));
            peso[cubo] += cuanto;
            sumaTono[cubo] += cuanto * tono;
        }

        let mandan = 0;
        for (let i = 1; i < CUBOS_TONO; i++) if (peso[i] > peso[mandan]) mandan = i;
        const total = peso.reduce((x, y) => x + y, 0);
        // Un cartel casi sin color: mejor no inventarse una paleta.
        if (!peso[mandan] || total < ancho * alto * 0.02) return null;

        return { principal: sumaTono[mandan] / peso[mandan] };
    }

    // ¿Da la talla el cartel para el hueco que tiene que llenar?
    //
    // El cartel llena su mitad siempre, se estire lo que se estire. Pero si la
    // imagen se queda corta, se marca el hueco para que el CSS le pase una
    // máscara de enfoque y recupere el filo que pierde al ampliarse. Con un
    // cartel grande no se marca nada y no se filtra nada.
    //
    // La cuenta es en píxeles DE VERDAD, no de web: una tablet corriente pinta
    // a 1,75 o a 2 puntos por píxel de web, así que media pantalla de 383 son
    // 670 u 800 puntos que hay que rellenar.
    function ajustarCalidadDelAfiche() {
        const img = document.getElementById('ficha-afiche-img');
        const hueco = document.querySelector('.pin-cartel');
        if (!img || !hueco || !img.naturalWidth) return;

        // Con la pantalla oculta el hueco mide cero y la cuenta no vale.
        const anchoCaja = hueco.clientWidth * (window.devicePixelRatio || 1);
        if (!anchoCaja) return;

        // El 90 % da margen: estirar un pelo no se nota y no compensa dejar
        // franjas negras por un 5 % de diferencia.
        hueco.classList.toggle('cartel-estirado', img.naturalWidth < anchoCaja * 0.9);
    }

    function pintarTemaDelAfiche(img) {
        const pantalla = document.getElementById('waiter-lock-modal');
        if (!pantalla) return;

        let tonos = null;
        try {
            tonos = tonosDelAfiche(img);
        } catch (err) {
            // Un lienzo "manchado" (la imagen viniendo de otro dominio) o un
            // navegador sin canvas: la pantalla se queda con su paleta.
            console.warn('No se pudo leer el color del afiche:', err);
        }
        if (!tonos) return;

        const t1 = Math.round(tonos.principal);
        const color = (tono, sat, luz) => 'hsl(' + tono + ', ' + sat + '%, ' + luz + '%)';

        // Tres variables y nada más. La pantalla es negra y blanca; del cartel
        // sólo entra el acento, y entra en dos sitios: el botón de Ingresar
        // encendido y el destello de la tecla al pulsarla.
        //
        // La claridad va fija —48 % para el acento— y de la foto sale sólo el
        // TONO. Es lo que hace que valga cualquier cartel: uno oscuro no deja
        // el botón negro sobre negro y uno pálido no lo deja ilegible. Aquí ya
        // hubo un analizador que copiaba el color tal cual y dejó botones
        // blancos sobre blanco (está contado en cargarFondo).
        //
        // El negro del fondo lleva un punto del tono del cartel: no se ve como
        // color, pero evita que la foto y el panel parezcan dos materiales
        // distintos pegados uno al lado del otro.
        const paleta = {
            '--ev-noche':       color(t1, 22, 4),
            '--ev-acento':      color(t1, 62, 48),
            '--ev-acento-vivo': color(t1, 68, 56)
        };

        Object.keys(paleta).forEach(nombre => {
            pantalla.style.setProperty(nombre, paleta[nombre]);
        });
    }

    function pintarConfiguracion() {
        ['evento', 'fecha', 'lugar', 'barra', 'responsable'].forEach(campo => {
            const el = document.getElementById('cfg-' + campo);
            if (el) el.value = configEvento[campo] || '';
        });

        const imgLogo = document.getElementById('logo-ticket-preview-img');
        const btnQuitar = document.getElementById('btn-quitar-logo-ticket');
        if (imgLogo) {
            imgLogo.src = '/api/configuracion/logo?v=' + Date.now();
        }
        if (btnQuitar) {
            if (configEvento.tiene_logo_ticket) {
                btnQuitar.classList.remove('hide');
            } else {
                btnQuitar.classList.add('hide');
            }
        }
    }

    document.getElementById('cfg-guardar-btn').addEventListener('click', async () => {
        const boton = document.getElementById('cfg-guardar-btn');
        const cuerpo = {};
        ['evento', 'fecha', 'lugar', 'barra', 'responsable'].forEach(campo => {
            cuerpo[campo] = document.getElementById('cfg-' + campo).value;
        });

        boton.disabled = true;
        try {
            const res = await fetch('/api/admin/configuracion-evento', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cuerpo)
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.message || 'error');

            configEvento = data.configuracion;
            pintarConfiguracion();
            // La pantalla de clave enseña estos mismos datos: se repinta aquí
            // para que el cambio se vea en la comanda siguiente y no haya que
            // recargar la tablet.
            pintarFichaEvento();
            // El nombre de la barra ES la identidad: al cambiarlo cambian la
            // etiqueta de la pantalla, el título de la pestaña y lo que se
            // imprime, así que se recargan sin reiniciar nada.
            if (data.instancia) {
                instancia = data.instancia;
                document.querySelectorAll('.instancia-badge').forEach(el => {
                    el.textContent = instancia.nombre;
                    el.classList.remove('hide');
                });
                document.title = 'MasterDrinks · ' + instancia.nombre;
                // La ficha de alta de cajeros enseña esta misma barra, así que
                // se repinta aquí y no hace falta salir y volver a la pestaña.
                pintarBarraDelCajero();
                actualizarTituloBarra();
            }
            notify('Datos del evento guardados.', 'ok');
        } catch (err) {
            notify(err.message || 'No se pudieron guardar los datos.', 'error');
        } finally {
            boton.disabled = false;
        }
    });

    // ------------------------------------------------------------------
    // LOGO DEL TICKET TÉRMICO (PERSONALIZACIÓN POR EVENTO)
    // ------------------------------------------------------------------
    const btnSubirLogoTicket = document.getElementById('btn-subir-logo-ticket');
    const inputSubirLogoTicket = document.getElementById('input-subir-logo-ticket');
    const btnQuitarLogoTicket = document.getElementById('btn-quitar-logo-ticket');
    const imgLogoTicketPreview = document.getElementById('logo-ticket-preview-img');

    if (btnSubirLogoTicket && inputSubirLogoTicket) {
        btnSubirLogoTicket.addEventListener('click', () => {
            inputSubirLogoTicket.click();
        });

        inputSubirLogoTicket.addEventListener('change', async (e) => {
            const archivo = e.target.files && e.target.files[0];
            if (!archivo) return;

            if (!archivo.type.startsWith('image/')) {
                notify('Por favor selecciona una imagen válida (PNG, JPG o WEBP).', 'warn');
                inputSubirLogoTicket.value = '';
                return;
            }

            if (archivo.size > 500 * 1024) {
                notify('La imagen no debe superar los 500 KB.', 'warn');
                inputSubirLogoTicket.value = '';
                return;
            }

            const lector = new FileReader();
            lector.onload = async () => {
                const base64 = lector.result;
                btnSubirLogoTicket.disabled = true;
                btnSubirLogoTicket.textContent = '⏳ Subiendo...';

                try {
                    const res = await fetch('/api/admin/configuracion/logo', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            logo: base64,
                            id_admin: currentUser ? currentUser.id_admin : 1
                        })
                    });

                    const data = await res.json();
                    if (!res.ok || !data.success) {
                        notify(data.message || 'No se pudo guardar el logo.', 'error');
                        return;
                    }

                    notify(data.message || 'Logo de tickets actualizado.', 'ok');
                    configEvento.tiene_logo_ticket = 1;
                    const nuevoUrl = '/api/configuracion/logo?t=' + Date.now();
                    if (imgLogoTicketPreview) imgLogoTicketPreview.src = nuevoUrl;
                    if (btnQuitarLogoTicket) btnQuitarLogoTicket.classList.remove('hide');
                    if (window.ThermalPrinter && typeof window.ThermalPrinter.setLogoUrl === 'function') {
                        window.ThermalPrinter.setLogoUrl(nuevoUrl);
                    }
                } catch (err) {
                    console.error('Error al subir logo de ticket:', err);
                    notify('Error de red al subir el logo.', 'error');
                } finally {
                    btnSubirLogoTicket.disabled = false;
                    btnSubirLogoTicket.textContent = '📁 Cambiar logo';
                    inputSubirLogoTicket.value = '';
                }
            };
            lector.readAsDataURL(archivo);
        });
    }

    if (btnQuitarLogoTicket) {
        btnQuitarLogoTicket.addEventListener('click', async () => {
            if (!confirm('¿Restablecer el logo del ticket al predeterminado de Euphoria?')) return;
            btnQuitarLogoTicket.disabled = true;
            try {
                const res = await fetch('/api/admin/configuracion/logo', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id_admin: currentUser ? currentUser.id_admin : 1
                    })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    notify(data.message || 'No se pudo restablecer el logo.', 'error');
                    return;
                }
                notify(data.message || 'Logo restablecido al predeterminado.', 'ok');
                configEvento.tiene_logo_ticket = 0;
                const nuevoUrl = '/api/configuracion/logo?t=' + Date.now();
                if (imgLogoTicketPreview) imgLogoTicketPreview.src = nuevoUrl;
                btnQuitarLogoTicket.classList.add('hide');
                if (window.ThermalPrinter && typeof window.ThermalPrinter.setLogoUrl === 'function') {
                    window.ThermalPrinter.setLogoUrl(nuevoUrl);
                }
            } catch (err) {
                console.error('Error al restablecer logo de ticket:', err);
                notify('Error de red al restablecer el logo.', 'error');
            } finally {
                btnQuitarLogoTicket.disabled = false;
            }
        });
    }

    // ------------------------------------------------------------------
    // GESTIÓN DEL AFICHE / CARTEL EN EL PANEL DE ADMINISTRACIÓN
    // ------------------------------------------------------------------
    async function cargarInfoAficheAdmin() {
        const previewImg = document.getElementById('admin-afiche-preview');
        const emptyBox = document.getElementById('admin-afiche-placeholder');
        const nombreEl = document.getElementById('admin-afiche-nombre');
        const resEl = document.getElementById('admin-afiche-res');
        const pesoEl = document.getElementById('admin-afiche-peso');
        const estadoEl = document.getElementById('admin-afiche-estado');
        const btnQuitar = document.getElementById('btn-quitar-afiche');

        if (!nombreEl) return;

        try {
            const res = await fetch('/api/admin/afiche');
            const data = await res.json();

            if (data.existe || data.exists) {
                if (previewImg) {
                    previewImg.src = data.url;
                    previewImg.classList.remove('hide');
                }
                if (emptyBox) emptyBox.classList.add('hide');
                if (nombreEl) nombreEl.textContent = data.archivo || data.nombre || 'afiche.jpg';
                if (resEl) resEl.textContent = (data.ancho && data.alto) ? `${data.ancho} × ${data.alto} px` : '—';
                if (pesoEl) pesoEl.textContent = data.tamano_kb ? `${data.tamano_kb} KB` : (data.peso ? `${Math.round(data.peso / 1024)} KB` : '—');
                if (estadoEl) {
                    estadoEl.textContent = 'ACTIVO';
                    estadoEl.className = 'tag-status activo';
                }
                if (btnQuitar) btnQuitar.classList.remove('hide');
            } else {
                if (previewImg) {
                    previewImg.src = '';
                    previewImg.classList.add('hide');
                }
                if (emptyBox) emptyBox.classList.remove('hide');
                if (nombreEl) nombreEl.textContent = 'Sin afiche cargado';
                if (resEl) resEl.textContent = '—';
                if (pesoEl) pesoEl.textContent = '—';
                if (estadoEl) {
                    estadoEl.textContent = 'SIN CARTEL';
                    estadoEl.className = 'tag-status inactivo';
                }
                if (btnQuitar) btnQuitar.classList.add('hide');
            }
        } catch (err) {
            console.warn('No se pudo leer la información del afiche:', err);
        }
    }

    const btnCambiarAfiche = document.getElementById('btn-cambiar-afiche');
    const inputSubirAfiche = document.getElementById('input-subir-afiche');
    const btnQuitarAfiche = document.getElementById('btn-quitar-afiche');

    if (btnCambiarAfiche && inputSubirAfiche) {
        btnCambiarAfiche.addEventListener('click', () => {
            inputSubirAfiche.click();
        });

        inputSubirAfiche.addEventListener('change', async (e) => {
            const archivo = e.target.files && e.target.files[0];
            if (!archivo) return;

            if (!archivo.type.startsWith('image/')) {
                notify('Por favor selecciona un archivo de imagen válido (JPG, PNG, WEBP).', 'warn');
                inputSubirAfiche.value = '';
                return;
            }

            const lector = new FileReader();
            lector.onload = async () => {
                const base64 = lector.result;
                btnCambiarAfiche.disabled = true;
                btnCambiarAfiche.textContent = '⏳ Subiendo...';

                try {
                    const res = await fetch('/api/admin/afiche', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            foto: base64,
                            imagen: base64,
                            nombre: archivo.name,
                            nombre_archivo: archivo.name,
                            id_admin: currentUser ? currentUser.id_admin : 1
                        })
                    });

                    const data = await res.json();
                    if (!res.ok || !data.success) {
                        notify(data.message || 'No se pudo guardar el afiche.', 'error', 6000);
                        return;
                    }

                    notify(data.message || 'Afiche actualizado correctamente.', 'ok');
                    await cargarInfoAficheAdmin();

                    // Actualizar el afiche y el tema de la pantalla de bloqueo en vivo
                    const imgLock = document.getElementById('ficha-afiche-img');
                    const vacio = document.getElementById('ficha-afiche-vacio');
                    if (imgLock) {
                        imgLock.src = '/afiche?t=' + Date.now();
                        imgLock.classList.remove('hide');
                        if (vacio) vacio.classList.add('hide');
                    }
                } catch (err) {
                    console.error('Error al subir afiche:', err);
                    notify('Error al conectar con el servidor para subir el afiche.', 'error');
                } finally {
                    btnCambiarAfiche.disabled = false;
                    btnCambiarAfiche.textContent = '📷 Cambiar afiche';
                    inputSubirAfiche.value = '';
                }
            };
            lector.readAsDataURL(archivo);
        });
    }

    if (btnQuitarAfiche) {
        btnQuitarAfiche.addEventListener('click', async () => {
            const si = await pedirConfirmacion({
                titulo: '¿Quitar afiche?',
                mensaje: '¿Seguro que deseas quitar el afiche actual del evento?',
                textoAceptar: 'Quitar afiche',
                textoCancelar: 'Cancelar',
                tipo: 'aviso',
                icono: '🖼️'
            });
            if (!si) return;

            btnQuitarAfiche.disabled = true;
            try {
                const res = await fetch('/api/admin/afiche', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id_admin: currentUser ? currentUser.id_admin : 1 })
                });

                const data = await res.json();
                if (!res.ok || !data.success) {
                    notify(data.message || 'No se pudo quitar el afiche.', 'error');
                    return;
                }

                notify(data.message || 'Afiche eliminado.', 'ok');
                await cargarInfoAficheAdmin();

                // Actualizar pantalla de bloqueo
                const imgLock = document.getElementById('ficha-afiche-img');
                const vacio = document.getElementById('ficha-afiche-vacio');
                if (imgLock) {
                    imgLock.src = '';
                    imgLock.classList.add('hide');
                }
                if (vacio) {
                    vacio.textContent = configEvento.evento || 'MasterDrinks';
                    vacio.classList.remove('hide');
                }
            } catch (err) {
                notify('Sin conexión con el servidor.', 'error');
            } finally {
                btnQuitarAfiche.disabled = false;
            }
        });
    }

    // ==========================================
    // REPORTE DE CIERRE EN PDF
    // ==========================================
    // El PDF lo genera el servidor: aquí sólo se elige el rango y se pide.
    // Sumar en el navegador daría cifras distintas según cuándo se abrió la
    // pestaña, y un cierre de caja tiene que cuadrar con la base siempre.
    function rangoReporte() {
        const desde = document.getElementById('rep-desde').value;
        const hasta = document.getElementById('rep-hasta').value;
        const params = new URLSearchParams();
        if (desde) params.set('desde', desde);
        if (hasta) params.set('hasta', hasta);
        return { desde, hasta, query: params.toString() ? '?' + params.toString() : '' };
    }

    function validarRango(r) {
        if (r.desde && r.hasta && r.desde > r.hasta) {
            notify('La fecha "Desde" es posterior a la de "Hasta".', 'warn');
            return false;
        }
        return true;
    }

    function obtenerRangoJornadaShow() {
        const hoy = new Date();
        const ayer = new Date(hoy);
        ayer.setDate(hoy.getDate() - 1);
        const fIso = d => d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
        return { desde: fIso(ayer), hasta: fIso(hoy) };
    }

    // Inicializar campos con la jornada del show (ayer a hoy)
    const rInicial = obtenerRangoJornadaShow();
    const inputDesde = document.getElementById('rep-desde');
    const inputHasta = document.getElementById('rep-hasta');
    if (inputDesde && !inputDesde.value) inputDesde.value = rInicial.desde;
    if (inputHasta && !inputHasta.value) inputHasta.value = rInicial.hasta;

    const repHoyBtn = document.getElementById('rep-hoy-btn');
    if (repHoyBtn) {
        repHoyBtn.addEventListener('click', () => {
            const r = obtenerRangoJornadaShow();
            if (inputDesde) inputDesde.value = r.desde;
            if (inputHasta) inputHasta.value = r.hasta;
            notify('Rango puesto en ayer y hoy (jornada del show).', 'info');
        });
    }

    // Resumen en pantalla antes de descargar: evita generar el PDF para
    // descubrir que el rango elegido no tiene ventas.
    document.getElementById('rep-ver-btn').addEventListener('click', async () => {
        const r = rangoReporte();
        if (!validarRango(r)) return;

        const caja = document.getElementById('rep-preview');
        caja.classList.remove('hide');
        caja.textContent = 'Calculando...';

        try {
            const res = await fetch('/api/admin/reporte' + r.query);
            if (!res.ok) throw new Error('respuesta ' + res.status);
            const d = await res.json();

            const fila = (etiqueta, valor, clase) =>
                `<div class="rep-row ${clase || ''}"><span>${escapeHtml(etiqueta)}</span>` +
                `<strong>${escapeHtml(valor)}</strong></div>`;

            caja.innerHTML =
                fila('Recaudado', d.resumen.recaudado.toFixed(2) + ' Bs.', 'destacada') +
                fila('Comandas cobradas', String(d.resumen.validas)) +
                fila('Anuladas', d.resumen.anuladas + ' (' + d.resumen.importe_anulado.toFixed(2) + ' Bs.)',
                    d.resumen.anuladas > 0 ? 'alerta' : '') +
                '<div class="rep-separador"></div>' +
                d.porMetodo.map(m => fila(m.metodo, Number(m.importe).toFixed(2) + ' Bs.')).join('') +
                (d.porMetodo.length === 0 ? '<div class="rep-row"><span>Sin cobros en este rango</span></div>' : '');
        } catch (err) {
            caja.textContent = 'No se pudo calcular el reporte.';
            notify('No se pudo calcular el reporte.', 'error');
        }
    });

    document.getElementById('rep-pdf-btn').addEventListener('click', async () => {
        const r = rangoReporte();
        if (!validarRango(r)) return;

        const boton = document.getElementById('rep-pdf-btn');
        const etiqueta = boton.textContent;
        boton.disabled = true;
        boton.classList.add('is-busy');
        boton.textContent = 'Generando...';

        try {
            // Se descarga por fetch en vez de con un enlace directo para poder
            // avisar si falla: un <a href> que devuelve un error 500 deja al
            // admin mirando una pestaña en blanco sin saber qué pasó.
            const res = await fetch('/api/admin/reporte.pdf' + r.query);
            if (!res.ok) throw new Error('respuesta ' + res.status);

            const blob = await res.blob();
            const cabecera = res.headers.get('Content-Disposition') || '';
            const coincide = cabecera.match(/filename="([^"]+)"/);
            const nombre = coincide ? coincide[1] : 'Cierre_Caja_MasterDrinks.pdf';

            const url = URL.createObjectURL(blob);
            const enlace = document.createElement('a');
            enlace.href = url;
            enlace.download = nombre;
            document.body.appendChild(enlace);
            enlace.click();
            enlace.remove();
            // Se libera con margen: si se revoca al instante, Android puede
            // quedarse sin la fuente antes de terminar de guardar el archivo.
            setTimeout(() => URL.revokeObjectURL(url), 20000);

            notify('Reporte descargado: ' + nombre, 'ok', 6000);
        } catch (err) {
            console.error('Error al descargar el reporte:', err);
            notify('No se pudo generar el PDF del reporte.', 'error');
        } finally {
            boton.disabled = false;
            boton.classList.remove('is-busy');
            boton.textContent = etiqueta;
        }
    });

    // TAB: COMANDAS / VOID LIST
    let todasLasComandas = [];
    let comandasFiltradas = [];
    let paginaActualComandas = 1;
    let filtroEstadoComanda = 'todos';
    const COMANDAS_POR_PAGINA = 6;

    async function loadComandasData() {
        try {
            const response = await fetch('/api/admin/comandas');
            todasLasComandas = await response.json();

            // Actualizar chips de resumen superior
            const completadas = todasLasComandas.filter(c => c.estado_pago !== 'ANULADO').length;
            const anuladas = todasLasComandas.filter(c => c.estado_pago === 'ANULADO').length;
            const chipTodas = document.getElementById('chip-todas');
            const chipComp = document.getElementById('chip-completadas');
            const chipAnul = document.getElementById('chip-anuladas');
            if (chipTodas) chipTodas.innerHTML = `<b>${todasLasComandas.length}</b> Todas`;
            if (chipComp) chipComp.innerHTML = `<b>${completadas}</b> Completadas`;
            if (chipAnul) chipAnul.innerHTML = `<b>${anuladas}</b> Anuladas`;

            actualizarOpcionesFiltroMesero();
            filtrarComandas(false);
        } catch (err) {
            console.error("Error loading comandas:", err);
        }
    }

    function actualizarOpcionesFiltroMesero() {
        const sel = document.getElementById('comanda-filter-mesero');
        if (!sel) return;
        const actual = sel.value;
        const meseros = new Set();
        todasLasComandas.forEach(c => {
            if (c.nombre_mesero && c.nombre_mesero.trim()) {
                meseros.add(c.nombre_mesero.trim());
            }
        });
        sel.innerHTML = '<option value="">Todos los meseros</option>';
        [...meseros].sort((a, b) => a.localeCompare(b)).forEach(nom => {
            const opt = document.createElement('option');
            opt.value = nom.toLowerCase();
            opt.textContent = nom;
            if (nom.toLowerCase() === actual.toLowerCase()) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    function filtrarComandas(resetPage = true) {
        if (resetPage) paginaActualComandas = 1;

        const searchInput = document.getElementById('comanda-search-input');
        const rawQuery = searchInput ? searchInput.value.trim() : '';
        // REGLA CRÍTICA: BÚSQUEDA EXCLUSIVAMENTE POR NÚMERO DE COMANDA (NO mesero, NO producto)
        const numQuery = rawQuery.replace(/[^0-9]/g, '');

        const selectMesero = document.getElementById('comanda-filter-mesero');
        const meseroVal = selectMesero ? selectMesero.value.toLowerCase().trim() : '';

        const selectPago = document.getElementById('comanda-filter-pago');
        const pagoVal = selectPago ? selectPago.value.toLowerCase().trim() : '';

        const inputDesde = document.getElementById('comanda-filter-desde');
        const desdeVal = inputDesde ? inputDesde.value.trim() : '';

        const inputHasta = document.getElementById('comanda-filter-hasta');
        const hastaVal = inputHasta ? inputHasta.value.trim() : '';

        // Comprobar si hay algún filtro activo para mostrar botón Limpiar
        const hayFiltros = Boolean(rawQuery || meseroVal || pagoVal || desdeVal || hastaVal || filtroEstadoComanda !== 'todos');
        const btnLimpiar = document.getElementById('comanda-btn-limpiar');
        if (btnLimpiar) {
            btnLimpiar.classList.toggle('hide', !hayFiltros);
        }

        comandasFiltradas = todasLasComandas.filter(c => {
            // 1. FILTRO ÚNICAMENTE POR NÚMERO DE COMANDA
            if (numQuery) {
                const idStr = String(c.id_comanda);
                if (!idStr.includes(numQuery)) return false;
            } else if (rawQuery && !numQuery) {
                // Escribió caracteres no numéricos pero la búsqueda es SOLO por número
                return false;
            }

            // 2. FILTRO POR ESTADO (Todas / Completadas / Anuladas)
            const isAnulado = c.estado_pago === 'ANULADO';
            if (filtroEstadoComanda === 'completadas' && isAnulado) return false;
            if (filtroEstadoComanda === 'anuladas' && !isAnulado) return false;

            // 3. FILTRO POR MESERO
            if (meseroVal) {
                const meseroNom = (c.nombre_mesero || '').toLowerCase();
                if (meseroNom !== meseroVal) return false;
            }

            // 4. FILTRO POR MÉTODO DE PAGO
            if (pagoVal) {
                const pagos = c.pagos || [];
                if (pagoVal === 'mixto') {
                    if (pagos.length < 2) return false;
                } else {
                    const coincide = pagos.some(p => (p.nombre_metodo || '').toLowerCase().includes(pagoVal));
                    if (!coincide) return false;
                }
            }

            // 5. FILTRO POR RANGO DE FECHAS (DESDE / HASTA)
            if (desdeVal || hastaVal) {
                const fComanda = (c.fecha_hora || '').slice(0, 10);
                if (desdeVal && fComanda < desdeVal) return false;
                if (hastaVal && fComanda > hastaVal) return false;
            }

            return true;
        });

        renderComandas();
    }

    function renderComandas() {
        const container = document.getElementById('comandas-cards-container');
        const pagContainer = document.getElementById('comandas-pagination');
        if (!container) return;
        container.innerHTML = '';

        if (comandasFiltradas.length === 0) {
            container.innerHTML = `<div style="text-align: center; color: var(--text-secondary); width: 100%; grid-column: 1/-1; padding: 40px; font-weight: 600;">No hay comandas registradas</div>`;
            if (pagContainer) pagContainer.innerHTML = '';
            return;
        }

        const totalItems = comandasFiltradas.length;
        const totalPaginas = Math.ceil(totalItems / COMANDAS_POR_PAGINA) || 1;
        if (paginaActualComandas > totalPaginas) paginaActualComandas = totalPaginas;
        if (paginaActualComandas < 1) paginaActualComandas = 1;

        const inicio = (paginaActualComandas - 1) * COMANDAS_POR_PAGINA;
        const itemsPagina = comandasFiltradas.slice(inicio, inicio + COMANDAS_POR_PAGINA);

        itemsPagina.forEach(c => {
            const isAnulado = c.estado_pago === 'ANULADO';
            const cardClass = isAnulado ? 'comanda-mini-card comanda-anulada' : 'comanda-mini-card comanda-vendida';

            const fechaD = new Date(c.fecha_hora);
            const dos = n => String(n).padStart(2, '0');
            const fechaStr = isNaN(fechaD.getTime()) ? '' : `${dos(fechaD.getDate())}/${dos(fechaD.getMonth() + 1)}/${fechaD.getFullYear()} ${dos(fechaD.getHours())}:${dos(fechaD.getMinutes())}`;

            const formatearMonto = n => {
                const val = parseFloat(n) || 0;
                return val.toLocaleString('es-BO', { maximumFractionDigits: 2 });
            };

            const detailsHtml = c.detalles.map(d => {
                const subt = d.subtotal ? `<span class="comanda-item-sub">*(Bs ${formatearMonto(d.subtotal)})*</span>` : '';
                return `<li class="comanda-item-line ${isAnulado ? 'tachado' : ''}">• ${d.cantidad}x ${escapeHtml(d.nombre_producto)} ${subt}</li>`;
            }).join('');

            const card = document.createElement('div');
            card.className = cardClass;
            card.setAttribute('data-id', c.id_comanda.toString());
            card.setAttribute('data-waiter', c.nombre_mesero || '');

            card.innerHTML = `
                <div class="comanda-card-layout">
                    <div class="comanda-card-main">
                        <div>
                            <div class="comanda-tags-row">
                                <span class="comanda-pill">Comanda #${escapeHtml(refComanda(c.id_comanda))}</span>
                                <span class="comanda-pill comanda-status-pill ${isAnulado ? 'badge-anulado' : 'badge-pagado'}">
                                    ${isAnulado ? '✖ Anulada' : '✔ Vendida'}
                                </span>
                            </div>
                            <div class="comanda-client-name">${escapeHtml(c.nombre_mesero || 'Mesero')}</div>
                            <ul class="comanda-products-list">
                                ${detailsHtml}
                            </ul>
                            ${isAnulado && c.motivo_anulacion ? `<div class="comanda-void-reason">Motivo: ${escapeHtml(c.motivo_anulacion)}</div>` : ''}
                            ${c.observaciones ? `<div class="comanda-obs-text">Obs: ${escapeHtml(c.observaciones)}</div>` : ''}
                        </div>
                        <div>
                            <div class="comanda-timestamp">${fechaStr}</div>
                            <div class="comanda-price-wrap">
                                <span class="comanda-price-capsule ${isAnulado ? 'tachado' : ''}">
                                    Bs ${formatearMonto(c.total)}
                                </span>
                            </div>
                        </div>
                    </div>
                    <div class="comanda-card-actions-side">
                        <button type="button" class="action-circle-btn print-card-btn" title="Reimprimir comanda" aria-label="Reimprimir">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
                                <circle cx="12" cy="12" r="3.2" fill="#000000"/>
                            </svg>
                        </button>
                        ${!isAnulado ? `
                        <button type="button" class="action-circle-btn danger-circle-btn void-card-btn" title="Anular comanda" aria-label="Anular">
                            <svg width="16" height="16" viewBox="0 0 24 24">
                                <circle cx="12" cy="12" r="9.5" fill="#000000"/>
                                <line x1="8.5" y1="8.5" x2="15.5" y2="15.5" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>
                                <line x1="15.5" y1="8.5" x2="8.5" y2="15.5" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>
                            </svg>
                        </button>
                        ` : ''}
                    </div>
                </div>
            `;

            // Button click listeners
            if (!isAnulado) {
                const voidBtn = card.querySelector('.void-card-btn');
                if (voidBtn) {
                    voidBtn.addEventListener('click', () => {
                        openVoidModal(c.id_comanda);
                    });
                }
            }

            const printBtn = card.querySelector('.print-card-btn');
            if (printBtn) {
                printBtn.addEventListener('click', () => {
                    const reprintData = {
                        total: parseFloat(c.total),
                        observaciones: c.observaciones,
                        nombre_cajero: c.nombre_cajero,
                        nombre_mesero: c.nombre_mesero,
                        nombre_barra: c.nombre_barra,
                        fecha_hora: c.fecha_hora,
                        items: c.detalles.map(d => ({
                            id_producto: d.id_producto,
                            nombre: d.nombre_producto,
                            cantidad: d.cantidad,
                            subtotal: parseFloat(d.subtotal)
                        })),
                        metodos_pago: c.pagos.map(p => ({
                            nombre_metodo: p.nombre_metodo,
                            referencia: p.referencia || '',
                            monto: parseFloat(p.monto)
                        }))
                    };
                    triggerThermalPrint(c.id_comanda, reprintData, true);
                });
            }

            container.appendChild(card);
        });

        renderPaginacionComandas(totalPaginas, totalItems);
    }

    function renderPaginacionComandas(totalPaginas, totalItems) {
        const pagContainer = document.getElementById('comandas-pagination');
        if (!pagContainer) return;
        if (totalPaginas <= 1 && totalItems <= COMANDAS_POR_PAGINA) {
            pagContainer.innerHTML = '';
            return;
        }

        let html = `
            <button type="button" class="comanda-pag-btn btn-prev" ${paginaActualComandas === 1 ? 'disabled' : ''}>
                ◀ Anterior
            </button>
        `;

        const maxBotones = 5;
        let startPage = Math.max(1, paginaActualComandas - Math.floor(maxBotones / 2));
        let endPage = Math.min(totalPaginas, startPage + maxBotones - 1);
        if (endPage - startPage + 1 < maxBotones) {
            startPage = Math.max(1, endPage - maxBotones + 1);
        }

        if (startPage > 1) {
            html += `<button type="button" class="comanda-pag-btn btn-num" data-page="1">1</button>`;
            if (startPage > 2) html += `<span class="comanda-pag-info">...</span>`;
        }

        for (let p = startPage; p <= endPage; p++) {
            html += `<button type="button" class="comanda-pag-btn btn-num ${p === paginaActualComandas ? 'active' : ''}" data-page="${p}">${p}</button>`;
        }

        if (endPage < totalPaginas) {
            if (endPage < totalPaginas - 1) html += `<span class="comanda-pag-info">...</span>`;
            html += `<button type="button" class="comanda-pag-btn btn-num" data-page="${totalPaginas}">${totalPaginas}</button>`;
        }

        html += `
            <button type="button" class="comanda-pag-btn btn-next" ${paginaActualComandas === totalPaginas ? 'disabled' : ''}>
                Siguiente ▶
            </button>
            <span class="comanda-pag-info">${totalItems} comanda${totalItems === 1 ? '' : 's'} (pág. ${paginaActualComandas}/${totalPaginas})</span>
        `;

        pagContainer.innerHTML = html;

        const prevBtn = pagContainer.querySelector('.btn-prev');
        if (prevBtn) {
            prevBtn.addEventListener('click', () => {
                if (paginaActualComandas > 1) {
                    paginaActualComandas--;
                    renderComandas();
                }
            });
        }

        const nextBtn = pagContainer.querySelector('.btn-next');
        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                if (paginaActualComandas < totalPaginas) {
                    paginaActualComandas++;
                    renderComandas();
                }
            });
        }

        pagContainer.querySelectorAll('.btn-num').forEach(btn => {
            btn.addEventListener('click', () => {
                const p = parseInt(btn.getAttribute('data-page'), 10);
                if (p && p !== paginaActualComandas) {
                    paginaActualComandas = p;
                    renderComandas();
                }
            });
        });
    }

    // Event listeners para los filtros de comandas
    const comandaSearchInput = document.getElementById('comanda-search-input');
    if (comandaSearchInput) {
        comandaSearchInput.addEventListener('input', () => filtrarComandas(true));
    }

    const selectFilterMesero = document.getElementById('comanda-filter-mesero');
    if (selectFilterMesero) {
        selectFilterMesero.addEventListener('change', () => filtrarComandas(true));
    }

    const selectFilterPago = document.getElementById('comanda-filter-pago');
    if (selectFilterPago) {
        selectFilterPago.addEventListener('change', () => filtrarComandas(true));
    }

    const inputFilterDesde = document.getElementById('comanda-filter-desde');
    if (inputFilterDesde) {
        inputFilterDesde.addEventListener('change', () => filtrarComandas(true));
    }

    const inputFilterHasta = document.getElementById('comanda-filter-hasta');
    if (inputFilterHasta) {
        inputFilterHasta.addEventListener('change', () => filtrarComandas(true));
    }

    // Chips interactivas de Estado (Todas / Completadas / Anuladas)
    document.querySelectorAll('.comandas-summary-pills .comanda-pill-badge').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.comandas-summary-pills .comanda-pill-badge').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filtroEstadoComanda = btn.dataset.estado || 'todos';
            filtrarComandas(true);
        });
    });

    // Botón Limpiar filtros
    const btnLimpiarComandas = document.getElementById('comanda-btn-limpiar');
    if (btnLimpiarComandas) {
        btnLimpiarComandas.addEventListener('click', () => {
            if (comandaSearchInput) comandaSearchInput.value = '';
            if (selectFilterMesero) selectFilterMesero.value = '';
            if (selectFilterPago) selectFilterPago.value = '';
            if (inputFilterDesde) inputFilterDesde.value = '';
            if (inputFilterHasta) inputFilterHasta.value = '';
            filtroEstadoComanda = 'todos';
            document.querySelectorAll('.comandas-summary-pills .comanda-pill-badge').forEach(b => {
                b.classList.toggle('active', b.dataset.estado === 'todos');
            });
            filtrarComandas(true);
        });
    }

    // Descarga de reporte de comandas en PDF con filtros sincronizados
    const btnComandasPdf = document.getElementById('comandas-quick-pdf');
    if (btnComandasPdf) {
        btnComandasPdf.addEventListener('click', async () => {
            const labelSpan = btnComandasPdf.querySelector('span');
            const originalText = labelSpan ? labelSpan.textContent : 'PDF';
            btnComandasPdf.disabled = true;
            btnComandasPdf.classList.add('is-busy');
            if (labelSpan) labelSpan.textContent = '...';

            try {
                const rawQuery = comandaSearchInput ? comandaSearchInput.value.trim() : '';
                const numQuery = rawQuery.replace(/[^0-9]/g, '');
                const meseroVal = selectFilterMesero ? selectFilterMesero.value.trim() : '';
                const desdeVal = inputFilterDesde ? inputFilterDesde.value.trim() : '';
                const hastaVal = inputFilterHasta ? inputFilterHasta.value.trim() : '';

                const params = new URLSearchParams();
                if (numQuery) params.set('q', numQuery);
                if (filtroEstadoComanda && filtroEstadoComanda !== 'todos') params.set('estado', filtroEstadoComanda);
                if (meseroVal) params.set('mesero', meseroVal);
                if (desdeVal) params.set('desde', desdeVal);
                if (hastaVal) params.set('hasta', hastaVal);

                const qs = params.toString();
                const url = '/api/admin/comandas.pdf' + (qs ? '?' + qs : '');

                const res = await fetch(url);
                if (!res.ok) throw new Error('respuesta ' + res.status);

                const blob = await res.blob();
                const cabecera = res.headers.get('Content-Disposition') || '';
                const coincide = cabecera.match(/filename="([^"]+)"/);
                const nombre = coincide ? coincide[1] : 'Reporte_Comandas_MasterDrinks.pdf';

                const blobUrl = URL.createObjectURL(blob);
                const enlace = document.createElement('a');
                enlace.href = blobUrl;
                enlace.download = nombre;
                document.body.appendChild(enlace);
                enlace.click();
                enlace.remove();
                setTimeout(() => URL.revokeObjectURL(blobUrl), 20000);

                notify('Reporte de comandas descargado: ' + nombre, 'ok', 6000);
            } catch (err) {
                console.error('Error al descargar el PDF de comandas:', err);
                notify('No se pudo generar el PDF de comandas.', 'error');
            } finally {
                btnComandasPdf.disabled = false;
                btnComandasPdf.classList.remove('is-busy');
                if (labelSpan) labelSpan.textContent = originalText;
            }
        });
    }

    // Global reference for onclick void
    window.openVoidModal = function(id_comanda) {
        document.getElementById('void-order-id-label').textContent = refComanda(id_comanda);
        document.getElementById('void-order-id-input').value = id_comanda;
        document.getElementById('void-reason').value = '';
        voidModal.classList.remove('hide');
    };

    // Close void confirmation modal
    document.getElementById('cancel-void-btn').addEventListener('click', () => {
        voidModal.classList.add('hide');
    });

    // Submit void order form
    voidForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id_comanda = document.getElementById('void-order-id-input').value;
        const motivo_anulacion = document.getElementById('void-reason').value;

        try {
            const response = await fetch('/api/admin/comandas/anular', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_comanda, id_admin: currentUser.id_admin, motivo_anulacion })
            });
            const data = await response.json();

            if (data.success) {
                voidModal.classList.add('hide');
                loadComandasData(); // Refresh list
            } else {
                notify(data.message || 'No se pudo anular la comanda.', 'error');
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    });

    // TAB: CATALOG SETUP (CREATE CATEGORY / PRODUCT)
    async function loadCatalogSetup() {
        try {
            // Fetch categories for product form selector
            const response = await fetch('/api/productos');
            const data = await response.json();

            const select = document.getElementById('prod-cat');
            select.innerHTML = '<option value="" disabled selected>Seleccione categoría...</option>';
            data.categorias.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id_categoria;
                opt.textContent = c.nombre;
                select.appendChild(opt);
            });
        } catch (err) {
            console.error(err);
        }
    }

    // Form: Create Category
    document.getElementById('form-create-category').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nombre = document.getElementById('cat-name').value;
        const descripcion = document.getElementById('cat-desc').value;
        const tipo = document.getElementById('cat-type').value;

        try {
            const response = await fetch('/api/admin/categorias', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre, descripcion, tipo, id_admin: currentUser.id_admin, id_evento: currentUser.id_evento })
            });
            const data = await response.json();

            if (data.success) {
                notify('Categoría creada.', 'ok');
                document.getElementById('form-create-category').reset();
                loadCatalogSetup(); // Refresh product selector
            } else {
                notify(data.message || 'No se pudo completar la operación.', 'error');
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    });

    // Form: Create Product
    document.getElementById('form-create-product').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id_categoria = document.getElementById('prod-cat').value;
        const nombre = document.getElementById('prod-name').value;
        const descripcion = document.getElementById('prod-desc').value;
        const tipo_producto = document.getElementById('prod-type').value;
        const precio_venta = document.getElementById('prod-price').value;
        const stock_actual = document.getElementById('prod-stock').value;

        try {
            const response = await fetch('/api/admin/productos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    foto: fotoNuevoProducto,
                    requiere_acompanante: document.getElementById('prod-requiere').checked,
                    es_acompanante: document.getElementById('prod-es-acomp').checked,
                    id_categoria, nombre, descripcion, tipo_producto, precio_venta, stock_actual,
                    id_admin: currentUser.id_admin, id_evento: currentUser.id_evento
                })
            });
            const data = await response.json();

            if (data.success) {
                notify('Producto creado.', 'ok');
                document.getElementById('form-create-product').reset();
                // reset() no vacía la vista previa de la foto: es un <div>, no
                // un campo del formulario.
                limpiarFotoDelFormulario();
                // reset() sí desmarca las casillas, pero se dejan explícitas
                // porque el alta siguiente no debe heredar nada de la anterior.
                document.getElementById('prod-requiere').checked = false;
                document.getElementById('prod-es-acomp').checked = false;
                cargarCatalogoAdmin();
            } else {
                notify(data.message || 'No se pudo completar la operación.', 'error');
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    });

    // ==========================================
    // FOTOS DE PRODUCTO
    // ==========================================
    // La foto se reduce aquí, en la tablet, antes de salir por la red.
    //
    // Una foto de la cámara son 3-8 MB. Sin reducir habría que subirlos por el
    // WiFi del hotspot, guardarlos en el .db y volver a bajarlos en cada tablet
    // cliente al abrir la caja: la rejilla de productos tardaría segundos en
    // pintarse. Reducida a 400 px de lado pesa unos 30 KB y se ve perfecta en
    // una tarjeta que mide 150.
    const FOTO_LADO = 400;
    const FOTO_CALIDAD = 0.82;
    // El mismo tope que aplica el servidor, con holgura: más vale recortar
    // aquí, donde todavía se puede cambiar de formato, que recibir un rechazo
    // cuando ya no queda nada que hacer.
    const FOTO_MAX_CARACTERES = Math.floor(400 * 1024 * 1.4 * 0.9);

    /**
     * ¿La imagen tiene algún píxel transparente?
     *
     * No se miran los cuatro millones de píxeles: basta el borde, que es donde
     * está el fondo de un recorte de producto. Se recorre el marco de fuera y
     * en cuanto aparece un píxel no opaco se para.
     */
    function tieneTransparencia(ctx, ancho, alto) {
        try {
            const puntos = [];
            const paso = Math.max(1, Math.floor(Math.min(ancho, alto) / 24));
            for (let x = 0; x < ancho; x += paso) puntos.push([x, 0], [x, alto - 1]);
            for (let y = 0; y < alto; y += paso) puntos.push([0, y], [ancho - 1, y]);
            for (const [x, y] of puntos) {
                if (ctx.getImageData(x, y, 1, 1).data[3] < 250) return true;
            }
        } catch (err) {
            // Un lienzo "sucio" no deja leerse. Ante la duda, JPEG con blanco:
            // pesa menos y nunca sale con el fondo negro.
            return false;
        }
        return false;
    }

    function reducirImagen(archivo) {
        return new Promise((resolve, reject) => {
            const lector = new FileReader();
            lector.onerror = () => reject(new Error('No se pudo leer el archivo.'));
            lector.onload = () => {
                const img = new Image();
                img.onerror = () => reject(new Error('Ese archivo no es una imagen.'));
                img.onload = () => {
                    // Nunca se agranda: una foto pequeña se queda como está en
                    // vez de estirarse y verse borrosa.
                    const escala = Math.min(1, FOTO_LADO / Math.max(img.width, img.height));
                    const ancho = Math.max(1, Math.round(img.width * escala));
                    const alto = Math.max(1, Math.round(img.height * escala));

                    const lienzo = document.createElement('canvas');
                    lienzo.width = ancho;
                    lienzo.height = alto;
                    const ctx = lienzo.getContext('2d');
                    ctx.drawImage(img, 0, 0, ancho, alto);

                    // Si la foto trae fondo transparente se guarda en PNG y la
                    // botella queda recortada sobre el fondo oscuro de la
                    // tarjeta, que es como mejor se ve. Si es una foto normal
                    // se pasa a JPEG, que pesa la cuarta parte; en ese caso hay
                    // que pintar el blanco por debajo, porque un JPEG no tiene
                    // transparencia y lo que no se rellena sale negro.
                    try {
                        if (tieneTransparencia(ctx, ancho, alto)) {
                            const enPng = lienzo.toDataURL('image/png');
                            // El PNG no comprime como el JPEG. Una foto con
                            // mucho detalle puede pasarse del tamaño que acepta
                            // la base, y el aviso que le llegaría a quien la
                            // sube ("pesa demasiado") no dice qué hacer con
                            // ella. Si se pasa, se cambia a JPEG y se pierde el
                            // fondo recortado, que es mucho menos grave que no
                            // poder poner la foto.
                            if (enPng.length <= FOTO_MAX_CARACTERES) {
                                resolve(enPng);
                                return;
                            }
                        }
                        ctx.globalCompositeOperation = 'destination-over';
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, ancho, alto);
                        resolve(lienzo.toDataURL('image/jpeg', FOTO_CALIDAD));
                    } catch (err) {
                        reject(new Error('No se pudo procesar la imagen.'));
                    }
                };
                img.src = lector.result;
            };
            lector.readAsDataURL(archivo);
        });
    }

    // Pinta una foto (o el hueco de "sin foto") dentro de un contenedor.
    function pintarFoto(caja, dataUri) {
        if (!caja) return;
        caja.innerHTML = '';
        if (dataUri) {
            const img = document.createElement('img');
            img.src = dataUri;
            img.alt = '';
            caja.appendChild(img);
            caja.classList.add('tiene');
        } else {
            const vacio = document.createElement('span');
            vacio.className = 'foto-vacia';
            vacio.textContent = 'Sin foto';
            caja.appendChild(vacio);
            caja.classList.remove('tiene');
        }
    }

    // ---- Foto en el formulario de alta --------------------------------------
    let fotoNuevoProducto = null;

    const fotoInput = document.getElementById('prod-foto');
    const fotoVista = document.getElementById('prod-foto-vista');
    const fotoQuitar = document.getElementById('prod-foto-quitar');

    if (fotoInput) {
        fotoInput.addEventListener('change', async e => {
            const archivo = e.target.files && e.target.files[0];
            if (!archivo) return;
            try {
                fotoNuevoProducto = await reducirImagen(archivo);
                pintarFoto(fotoVista, fotoNuevoProducto);
                fotoQuitar.classList.remove('hide');
            } catch (err) {
                notify(err.message || 'No se pudo usar esa imagen.', 'error');
                fotoInput.value = '';
            }
        });

        fotoQuitar.addEventListener('click', () => {
            fotoNuevoProducto = null;
            fotoInput.value = '';
            pintarFoto(fotoVista, null);
            fotoQuitar.classList.add('hide');
        });
    }

    function limpiarFotoDelFormulario() {
        fotoNuevoProducto = null;
        if (fotoInput) fotoInput.value = '';
        pintarFoto(fotoVista, null);
        if (fotoQuitar) fotoQuitar.classList.add('hide');
    }

    // ---- Cambiar la foto de un producto que ya existe -----------------------
    // Un único control de archivo escondido que se reutiliza: crear uno por
    // fila dejaría veinte en la página sin ninguna ventaja.
    const fotoSuelta = document.createElement('input');
    fotoSuelta.type = 'file';
    fotoSuelta.accept = 'image/png,image/jpeg,image/webp';
    fotoSuelta.className = 'foto-input';
    document.body.appendChild(fotoSuelta);
    let productoDeLaFoto = null;

    fotoSuelta.addEventListener('change', async e => {
        const archivo = e.target.files && e.target.files[0];
        if (!archivo || !productoDeLaFoto) return;
        try {
            const dataUri = await reducirImagen(archivo);
            await guardarFotoProducto(productoDeLaFoto, dataUri);
        } catch (err) {
            notify(err.message || 'No se pudo usar esa imagen.', 'error');
        } finally {
            fotoSuelta.value = '';
            productoDeLaFoto = null;
        }
    });

    function pedirFotoPara(id_producto) {
        productoDeLaFoto = id_producto;
        fotoSuelta.click();
    }

    async function guardarFotoProducto(id_producto, dataUri) {
        try {
            const res = await fetch('/api/admin/productos/' + id_producto + '/foto', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ foto: dataUri })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo guardar la foto.', 'error');
                return;
            }
            notify(data.message, 'ok');
            cargarCatalogoAdmin();
            // La caja tiene que enterarse: si no, el cajero sigue viendo el
            // dibujito hasta que recargue la página.
            fetchProductsAndMenu();
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    }

    // ==========================================
    // LISTAS DEL PANEL: VER Y ELIMINAR
    // ==========================================
    // El panel sólo dejaba crear. No había forma de ver qué había ya, ni de
    // quitar lo que sobraba, así que el catálogo de ejemplo se quedaba mezclado
    // con los productos de verdad y en la caja aparecían cosas que no se venden.
    //
    // Eliminar no siempre borra: lo que ya tiene ventas se retira (deja de salir
    // en la caja) pero se conserva, porque el cierre de caja lo nombra. El
    // servidor decide cuál de los dos casos es y lo dice en su respuesta.

    // Pregunta antes de borrar con el modal nativo de la app
    function confirmarBorrado(texto) {
        const partes = String(texto || '').split('\n\n');
        const mensaje = partes[0] || '¿Deseas eliminar este elemento?';
        const detalle = partes.slice(1).join(' ').trim() || null;
        return pedirConfirmacion({
            titulo: '¿Eliminar elemento?',
            mensaje: mensaje,
            detalle: detalle,
            textoAceptar: 'Eliminar',
            textoCancelar: 'Cancelar',
            tipo: 'peligro',
            icono: '🗑️'
        });
    }

    async function borrar(url, texto, alTerminar) {
        const si = await confirmarBorrado(texto);
        if (!si) return;
        try {
            const res = await fetch(url, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_admin: currentUser ? currentUser.id_admin : 1 })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo eliminar.', 'error', 7000);
                return;
            }
            // Los retirados llevan más explicación que un simple "hecho": el
            // encargado tiene que entender por qué sigue existiendo.
            notify(data.message, data.retirado ? 'warn' : 'ok', data.retirado ? 8000 : 4000);
            if (alTerminar) alTerminar();
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    }

    // Una fila de lista.
    //
    // Va en DOS renglones y no en uno: el nombre arriba, ocupando todo el
    // ancho, y debajo los datos y las marcas.
    //
    // En una sola línea, las tres insignias ("vendido 1×", "con acompañante",
    // "es acompañante") más la foto y los botones se comían el sitio y el
    // nombre quedaba en "Ballant…" y "Chivas …": dos whiskys distintos que se
    // leían igual. El nombre es lo que se busca en esta lista, así que es lo
    // único que tiene garantizada la línea entera.
    function filaLista({ titulo, detalle, insignia, inactivo, onBorrar,
                         foto, onFoto, marcas, onEditar, nota,
                         onAlternar, alternarActivo, alternarTitulo,
                         onSubir, onBajar, deshabilitarSubir, deshabilitarBajar }) {
        const fila = document.createElement('div');
        fila.className = 'lista-fila' + (inactivo ? ' inactiva' : '');

        // Miniatura, sólo en las filas que pueden tenerla. Es un botón: se toca
        // la foto para ponerla o cambiarla.
        if (onFoto) {
            const btnFoto = document.createElement('button');
            btnFoto.type = 'button';
            btnFoto.className = 'lista-foto' + (foto ? ' tiene' : '');
            btnFoto.title = foto ? 'Cambiar la foto' : 'Añadir una foto';
            btnFoto.setAttribute('aria-label', (foto ? 'Cambiar' : 'Añadir') + ' foto de ' + titulo);
            if (foto) {
                const img = document.createElement('img');
                img.src = foto;
                img.alt = '';
                // Descarga diferida: con veinte fotos en la lista, cargarlas
                // todas de golpe retrasa el primer pintado de la pestaña.
                img.loading = 'lazy';
                btnFoto.appendChild(img);
            } else {
                btnFoto.textContent = '+';
            }
            btnFoto.addEventListener('click', onFoto);
            fila.appendChild(btnFoto);
        }

        const cuerpo = document.createElement('div');
        cuerpo.className = 'lista-cuerpo';

        // Renglón 1: el nombre, solo, con todo el ancho.
        const nombre = document.createElement('span');
        nombre.className = 'lista-nombre';
        nombre.textContent = titulo;
        cuerpo.appendChild(nombre);

        // Renglón 2: datos, insignias y marcas. Si no caben, saltan de línea
        // en vez de empujar al nombre.
        const meta = document.createElement('div');
        meta.className = 'lista-meta';

        if (detalle) {
            const sub = document.createElement('span');
            sub.className = 'lista-detalle';
            sub.textContent = detalle;
            meta.appendChild(sub);
        }

        if (insignia) {
            const ins = document.createElement('span');
            ins.className = 'lista-insignia';
            ins.textContent = insignia;
            meta.appendChild(ins);
        }

        if (inactivo) {
            const ret = document.createElement('span');
            ret.className = 'lista-insignia retirada';
            ret.textContent = 'Retirado';
            meta.appendChild(ret);
        }

        // Marcas alternables (acompañamiento). Se pintan siempre, encendidas o
        // apagadas: si sólo salieran las activas, no habría dónde tocar para
        // encender la primera.
        if (marcas && !inactivo) {
            marcas.forEach(m => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'lista-marca' + (m.activa ? ' activa' : '') + (m.clase ? ' ' + m.clase : '');
                b.textContent = m.texto;
                b.title = m.titulo || ((m.activa ? 'Quitar: ' : 'Marcar: ') + m.texto);
                b.setAttribute('aria-pressed', m.activa ? 'true' : 'false');
                b.addEventListener('click', m.onTocar);
                meta.appendChild(b);
            });
        }

        if (meta.childNodes.length) cuerpo.appendChild(meta);

        // Renglón 3, opcional: un texto largo que necesita el ancho entero y
        // puede saltar de línea. Lo que lleva dentro una promoción no cabe en
        // una insignia —"1 × Johnnie Walker Red Label + 2 × Cerveza Paceña 350
        // ml" son sesenta caracteres— y truncado no sirve de nada, porque lo
        // que se quiere comprobar de un vistazo es justo el final.
        if (nota) {
            const linea = document.createElement('div');
            linea.className = 'lista-nota';
            linea.textContent = nota;
            cuerpo.appendChild(linea);
        }

        fila.appendChild(cuerpo);

        // Acciones, siempre a la derecha y siempre en el mismo sitio.
        const acciones = document.createElement('div');
        acciones.className = 'lista-acciones';

        // Reordenar (subir / bajar)
        if (onSubir || onBajar) {
            const grpOrden = document.createElement('div');
            grpOrden.className = 'lista-orden-grp';

            if (onSubir) {
                const btnSubir = document.createElement('button');
                btnSubir.type = 'button';
                btnSubir.className = 'lista-orden-btn lista-subir' + (deshabilitarSubir ? ' deshabilitado' : '');
                btnSubir.title = 'Mover hacia arriba';
                btnSubir.setAttribute('aria-label', 'Mover hacia arriba ' + titulo);
                btnSubir.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`;
                if (deshabilitarSubir) {
                    btnSubir.disabled = true;
                } else {
                    btnSubir.addEventListener('click', (e) => {
                        e.stopPropagation();
                        onSubir();
                    });
                }
                grpOrden.appendChild(btnSubir);
            }

            if (onBajar) {
                const btnBajar = document.createElement('button');
                btnBajar.type = 'button';
                btnBajar.className = 'lista-orden-btn lista-bajar' + (deshabilitarBajar ? ' deshabilitado' : '');
                btnBajar.title = 'Mover hacia abajo';
                btnBajar.setAttribute('aria-label', 'Mover hacia abajo ' + titulo);
                btnBajar.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
                if (deshabilitarBajar) {
                    btnBajar.disabled = true;
                } else {
                    btnBajar.addEventListener('click', (e) => {
                        e.stopPropagation();
                        onBajar();
                    });
                }
                grpOrden.appendChild(btnBajar);
            }

            acciones.appendChild(grpOrden);
        }

        if (onEditar && !inactivo) {
            const ed = document.createElement('button');
            ed.type = 'button';
            ed.className = 'lista-editar';
            ed.title = 'Editar';
            ed.setAttribute('aria-label', 'Editar ' + titulo);
            ed.textContent = '✎';
            ed.addEventListener('click', onEditar);
            acciones.appendChild(ed);
        }


        if (onAlternar) {
            const btnAlt = document.createElement('button');
            btnAlt.type = 'button';
            btnAlt.className = 'lista-alternar' + (alternarActivo ? ' activo' : ' inactivo');
            btnAlt.title = alternarTitulo || (alternarActivo ? 'Desactivar' : 'Activar');
            btnAlt.setAttribute('aria-label', btnAlt.title);
            btnAlt.setAttribute('aria-pressed', alternarActivo ? 'true' : 'false');
            btnAlt.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>`;
            btnAlt.addEventListener('click', onAlternar);
            acciones.appendChild(btnAlt);
        }

        if (!inactivo) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lista-borrar';
            btn.title = 'Eliminar por completo';
            btn.setAttribute('aria-label', 'Eliminar por completo ' + titulo);
            btn.textContent = '✕';
            btn.addEventListener('click', onBorrar);
            acciones.appendChild(btn);
        }

        fila.appendChild(acciones);
        return fila;
    }

    // Cabecera de grupo. Una lista de cuarenta y cinco meseros seguidos no se
    // puede repasar; agrupada por cajero, cada bloque es del tamaño de lo que
    // una persona lleva a su cargo, que es como se reparte el trabajo.
    function cabeceraGrupo(texto, cuantos) {
        const h = document.createElement('div');
        h.className = 'lista-grupo';
        const a = document.createElement('span');
        a.className = 'lista-grupo-nombre';
        a.textContent = texto;
        h.appendChild(a);
        const b = document.createElement('span');
        b.className = 'lista-grupo-cuenta';
        b.textContent = cuantos;
        h.appendChild(b);
        return h;
    }

    // Agrupa conservando el orden de aparición: así el orden de los grupos no
    // baila entre un repintado y el siguiente.
    function agrupar(lista, claveDe) {
        const grupos = new Map();
        lista.forEach(x => {
            const k = claveDe(x) || 'Sin asignar';
            if (!grupos.has(k)) grupos.set(k, []);
            grupos.get(k).push(x);
        });
        return grupos;
    }

    function pintarVacio(contenedor, texto) {
        contenedor.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'lista-vacia';
        p.textContent = texto;
        contenedor.appendChild(p);
    }

    // ---- Catálogo -----------------------------------------------------------
    let catalogoAdmin = { categorias: [], productos: [] };

    async function cargarCatalogoAdmin() {
        try {
            const res = await fetch('/api/admin/catalogo');
            catalogoAdmin = await res.json();
        } catch (err) {
            catalogoAdmin = { categorias: [], productos: [] };
        }
        pintarCategorias();
        pintarProductosAdmin();
    }

    async function reordenarCategoriaPosicion(catId, direccion) {
        const cats = catalogoAdmin.categorias || [];
        const idx = cats.findIndex(c => c.id_categoria === catId);
        if (idx === -1) return;
        const targetIdx = direccion === 'arriba' ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= cats.length) return;

        // Swap en arreglo local
        const temp = cats[idx];
        cats[idx] = cats[targetIdx];
        cats[targetIdx] = temp;
        cats.forEach((c, i) => c.orden = i);

        // Repintar inmediatamente
        pintarCategorias();
        vibrar(20);

        try {
            const res = await fetch('/api/admin/categorias/reordenar', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ids: cats.map(c => c.id_categoria),
                    id_admin: currentUser ? currentUser.id_admin : 1
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'Error al guardar el nuevo orden.', 'error');
                await cargarCatalogoAdmin();
                return;
            }
            await Promise.all([loadCatalogSetup(), fetchProductsAndMenu()]);
        } catch (err) {
            console.error('Error reordenando categorías:', err);
            notify('Error de conexión al reordenar.', 'error');
            await cargarCatalogoAdmin();
        }
    }

    async function reordenarProductoPosicion(prodId, direccion) {
        const todos = catalogoAdmin.productos || [];
        const prod = todos.find(p => p.id_producto === prodId);
        if (!prod) return;

        // Productos de la misma categoría
        const enMismaCat = todos.filter(p => p.id_categoria === prod.id_categoria);
        const catIdx = enMismaCat.findIndex(p => p.id_producto === prodId);
        if (catIdx === -1) return;
        const targetCatIdx = direccion === 'arriba' ? catIdx - 1 : catIdx + 1;
        if (targetCatIdx < 0 || targetCatIdx >= enMismaCat.length) return;

        const otroProd = enMismaCat[targetCatIdx];
        const idxA = todos.findIndex(p => p.id_producto === prod.id_producto);
        const idxB = todos.findIndex(p => p.id_producto === otroProd.id_producto);
        if (idxA !== -1 && idxB !== -1) {
            const temp = todos[idxA];
            todos[idxA] = todos[idxB];
            todos[idxB] = temp;
        }
        todos.forEach((p, i) => p.orden = i);

        // Repintar inmediatamente
        pintarProductosAdmin();
        vibrar(20);

        try {
            const res = await fetch('/api/admin/productos/reordenar', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ids: todos.map(p => p.id_producto),
                    id_admin: currentUser ? currentUser.id_admin : 1
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'Error al guardar el nuevo orden.', 'error');
                await cargarCatalogoAdmin();
                return;
            }
            await fetchProductsAndMenu();
        } catch (err) {
            console.error('Error reordenando productos:', err);
            notify('Error de conexión al reordenar.', 'error');
            await cargarCatalogoAdmin();
        }
    }

    function pintarCategorias() {
        const cont = document.getElementById('lista-categorias');
        if (!cont) return;
        const cats = catalogoAdmin.categorias || [];
        document.getElementById('cont-categorias').textContent = cats.length;

        if (!cats.length) return pintarVacio(cont, 'Todavía no hay categorías.');

        cont.innerHTML = '';
        cats.forEach((c, idx) => {
            const estaActiva = c.activo !== 0;
            const fila = filaLista({
                titulo: c.nombre,
                detalle: c.descripcion || '',
                insignia: (c.productos + (c.productos === 1 ? ' producto' : ' productos')) + (!estaActiva ? ' · Desactivada' : ''),
                inactivo: false,
                onSubir: () => reordenarCategoriaPosicion(c.id_categoria, 'arriba'),
                onBajar: () => reordenarCategoriaPosicion(c.id_categoria, 'abajo'),
                deshabilitarSubir: idx === 0,
                deshabilitarBajar: idx === cats.length - 1,
                onEditar: () => abrirEditarCategoria(c),
                onAlternar: () => alternarCategoria(c),
                alternarActivo: estaActiva,
                alternarTitulo: estaActiva
                    ? `Desactivar "${c.nombre}" (ocultar de la caja sin borrar)`
                    : `Activar "${c.nombre}" (mostrar en la caja)`,
                onBorrar: () => borrar(
                    '/api/admin/categorias/' + c.id_categoria,
                    '¿Eliminar la categoría "' + c.nombre + '" por completo de la base de datos?',
                    () => { cargarCatalogoAdmin(); loadCatalogSetup(); })
            });
            if (!estaActiva) {
                fila.classList.add('cat-desactivada');
            }
            cont.appendChild(fila);
        });
    }

    async function alternarCategoria(cat) {
        try {
            const nuevoActivo = cat.activo ? 0 : 1;
            const res = await fetch('/api/admin/categorias/' + cat.id_categoria, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    activo: nuevoActivo,
                    id_admin: currentUser ? currentUser.id_admin : 1
                })
            });
            let data = {};
            try { data = await res.json(); } catch (_) {}

            if (!res.ok || !data.success) {
                notify(data.message || ('Error del servidor (código ' + res.status + ').'), 'error');
                return;
            }
            notify(nuevoActivo ? `Categoría "${cat.nombre}" activada.` : `Categoría "${cat.nombre}" desactivada.`, 'ok');
            await Promise.all([cargarCatalogoAdmin(), loadCatalogSetup(), fetchProductsAndMenu()]);
        } catch (err) {
            console.error('Error al alternar categoría:', err);
            notify('Sin conexión con el servidor. Revisa que el servidor esté activo.', 'error');
        }
    }

    async function alternarProducto(p) {
        try {
            const nuevoActivo = p.activo ? 0 : 1;
            const res = await fetch('/api/admin/productos/' + p.id_producto + '/estado', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    activo: nuevoActivo,
                    id_admin: currentUser ? currentUser.id_admin : 1
                })
            });
            let data = {};
            try { data = await res.json(); } catch (_) {}

            if (!res.ok || !data.success) {
                notify(data.message || ('Error del servidor (' + res.status + ').'), 'error');
                return;
            }
            notify(nuevoActivo ? `"${p.nombre}" activado.` : `"${p.nombre}" desactivado.`, 'ok');
            await Promise.all([cargarCatalogoAdmin(), fetchProductsAndMenu()]);
        } catch (err) {
            console.error('Error al alternar producto:', err);
            notify('Sin conexión con el servidor. Revisa que el servidor esté activo.', 'error');
        }
    }

    function pintarProductosAdmin() {
        const cont = document.getElementById('lista-productos');
        if (!cont) return;
        const filtro = (document.getElementById('buscar-producto-cat').value || '')
            .trim().toLowerCase();
        const todos = catalogoAdmin.productos || [];
        const lista = filtro
            ? todos.filter(p => (p.nombre || '').toLowerCase().includes(filtro))
            : todos;

        document.getElementById('cont-productos').textContent =
            filtro ? lista.length + ' de ' + todos.length : todos.length;

        if (!lista.length) {
            return pintarVacio(cont, filtro ? 'Ningún producto con ese nombre.' : 'Todavía no hay productos.');
        }

        cont.innerHTML = '';
        // Agrupados por categoría, como en la caja: repasar veinte productos
        // mezclados obliga a leerlos todos para saber si falta una cerveza.
        agrupar(lista, p => p.categoria).forEach((productos, categoria) => {
            const catObj = (catalogoAdmin.categorias || []).find(c => c.nombre === categoria);
            const estaDesactivada = catObj && catObj.activo === 0;
            cont.appendChild(cabeceraGrupo(categoria + (estaDesactivada ? ' · Desactivada' : ''), productos.length));
            productos.forEach((p, pIdx) => {
                const precio = Number(p.precio_venta).toFixed(2) + ' Bs.';
                const estaActivo = p.activo !== 0;
                const fila = filaLista({
                    titulo: p.nombre,
                    detalle: [precio, p.stock_actual + ' u.'].join(' · '),
                    insignia: (p.vendido > 0 ? 'vendido ' + p.vendido + '×' : '') + (!estaActivo ? ' · Desactivado' : ''),
                    inactivo: false,
                    foto: urlFoto(p),
                    onSubir: () => reordenarProductoPosicion(p.id_producto, 'arriba'),
                    onBajar: () => reordenarProductoPosicion(p.id_producto, 'abajo'),
                    deshabilitarSubir: pIdx === 0 || !!filtro,
                    deshabilitarBajar: pIdx === productos.length - 1 || !!filtro,
                    onEditar: () => abrirEditarProducto(p),
                    onAlternar: () => alternarProducto(p),
                    alternarActivo: estaActivo,
                    alternarTitulo: estaActivo
                        ? `Desactivar "${p.nombre}" (ocultar de la caja sin borrar)`
                        : `Activar "${p.nombre}" (mostrar en la caja)`,
                    marcas: [
                        { texto: 'con acompañante', activa: !!p.requiere_acompanante,
                          onTocar: () => marcarAcompanamiento(p, 'requiere') },
                        { texto: 'es acompañante', activa: !!p.es_acompanante,
                          onTocar: () => marcarAcompanamiento(p, 'es') }
                    ],
                    // La miniatura es el botón: se toca la foto para cambiarla, que
                    // es donde todo el mundo va a tocar de todas formas.
                    onFoto: () => pedirFotoPara(p.id_producto),
                    onBorrar: () => borrar(
                        '/api/admin/productos/' + p.id_producto,
                        p.vendido > 0
                            ? '"' + p.nombre + '" ya tiene ventas.\n\nSe retirará de la caja pero seguirá ' +
                              'apareciendo en el cierre. ¿Continuar?'
                            : '¿Eliminar "' + p.nombre + '"?',
                        () => { cargarCatalogoAdmin(); loadCatalogSetup(); })
                });
                if (!estaActivo) {
                    fila.classList.add('cat-desactivada');
                }
                cont.appendChild(fila);
            });
        });
    }

    // Cambia una de las dos marcas de acompañamiento. Se manda el estado
    // completo y no un "alterna esto": así el servidor no tiene que adivinar
    // nada y dos toques rápidos no pueden dejarlo en un estado a medias.
    async function marcarAcompanamiento(p, cual) {
        const requiere = cual === 'requiere' ? !p.requiere_acompanante : !!p.requiere_acompanante;
        const es = cual === 'es' ? !p.es_acompanante : !!p.es_acompanante;

        // Las dos a la vez no tienen sentido: un producto que pide acompañante
        // no puede ser el acompañante de otro. Se apaga la contraria sola en
        // vez de rechazar el toque y hacer que el encargado adivine por qué.
        const cuerpo = (requiere && es)
            ? { requiere_acompanante: cual === 'requiere', es_acompanante: cual === 'es' }
            : { requiere_acompanante: requiere, es_acompanante: es };

        try {
            const res = await fetch('/api/admin/productos/' + p.id_producto + '/acompanamiento', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cuerpo)
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo guardar.', 'error');
                return;
            }
            notify(data.message, 'ok');
            await Promise.all([cargarCatalogoAdmin(), fetchProductsAndMenu()]);
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    }

    // ---- Editar un producto -------------------------------------------------
    const editarModal = document.getElementById('editar-modal');
    let productoEditando = null;

    function abrirEditarProducto(p) {
        productoEditando = p;
        document.getElementById('editar-cual').textContent = p.nombre;
        document.getElementById('editar-nombre').value = p.nombre || '';
        document.getElementById('editar-precio').value = Number(p.precio_venta).toFixed(2);
        document.getElementById('editar-descripcion').value = p.descripcion || '';

        const sel = document.getElementById('editar-categoria');
        sel.innerHTML = '';
        (catalogoAdmin.categorias || []).forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id_categoria;
            opt.textContent = c.nombre + (c.activo === 0 ? ' (desactivada)' : '');
            sel.appendChild(opt);
        });
        sel.value = p.id_categoria || '';

        // Mostrar foto actual del producto
        const editFotoVista = document.getElementById('editar-foto-vista');
        if (editFotoVista) {
            if (p.tiene_foto) {
                const fotoUrl = '/api/producto/' + p.id_producto + '/foto?v=' + (p.foto_v || 0);
                editFotoVista.innerHTML = `<img src="${fotoUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px;">`;
                editFotoVista.classList.add('tiene');
            } else {
                editFotoVista.innerHTML = '<span class="foto-vacia">Sin foto</span>';
                editFotoVista.classList.remove('tiene');
            }
        }

        editarModal.classList.remove('hide');
        document.getElementById('editar-nombre').focus();
    }

    function cerrarEditarProducto() {
        editarModal.classList.add('hide');
        productoEditando = null;
    }

    async function guardarEdicionProducto() {
        if (!productoEditando) return;
        const idProd = productoEditando.id_producto;
        const boton = document.getElementById('editar-guardar');
        boton.disabled = true;

        const nuevoPrecio = Number(document.getElementById('editar-precio').value);
        const nuevoNombre = document.getElementById('editar-nombre').value;
        const nuevaCat = document.getElementById('editar-categoria').value;
        const nuevaDesc = document.getElementById('editar-descripcion').value;

        cerrarEditarProducto();
        if (catalogoAdmin && catalogoAdmin.productos) {
            const p = catalogoAdmin.productos.find(x => x.id_producto === idProd);
            if (p) {
                p.precio_venta = nuevoPrecio;
                p.nombre = nuevoNombre;
                p.id_categoria = Number(nuevaCat);
                p.descripcion = nuevaDesc;
            }
        }
        pintarProductosAdmin();

        try {
            const res = await fetch('/api/admin/productos/' + idProd, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nombre: nuevoNombre,
                    descripcion: nuevaDesc,
                    precio_venta: nuevoPrecio,
                    id_categoria: nuevaCat,
                    id_admin: currentUser ? currentUser.id_admin : 1
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo guardar.', 'error', 6000);
                return;
            }
            notify(data.message, 'ok');
            await Promise.all([cargarCatalogoAdmin(), loadCatalogSetup(), fetchProductsAndMenu()]);
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        } finally {
            boton.disabled = false;
        }
    }

    document.getElementById('editar-cerrar').addEventListener('click', cerrarEditarProducto);
    document.getElementById('editar-guardar').addEventListener('click', guardarEdicionProducto);
    editarModal.addEventListener('click', e => {
        if (e.target === editarModal) cerrarEditarProducto();
    });

    // Botoón cambiar foto en modal de edición
    document.getElementById('editar-foto-btn').addEventListener('click', () => {
        if (!productoEditando) return;
        // Reutilizamos fotoSuelta pero con un listener especial para el modal
        const idProd = productoEditando.id_producto;
        productoDeLaFoto = idProd;
        // Al guardar, actualizamos también la preview del modal
        const origChange = fotoSuelta.onchange;
        fotoSuelta.onchange = async (e) => {
            const archivo = e.target.files && e.target.files[0];
            if (!archivo) { fotoSuelta.onchange = null; return; }
            try {
                const dataUri = await reducirImagen(archivo);
                await guardarFotoProducto(idProd, dataUri);
                // Actualizar preview inmediatamente
                const editFotoVista = document.getElementById('editar-foto-vista');
                if (editFotoVista) {
                    editFotoVista.innerHTML = `<img src="${dataUri}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px;">`;
                    editFotoVista.classList.add('tiene');
                }
            } catch (err) {
                notify(err.message || 'No se pudo usar esa imagen.', 'error');
            } finally {
                fotoSuelta.value = '';
                fotoSuelta.onchange = null;
                productoDeLaFoto = null;
            }
        };
        fotoSuelta.click();
    });

    // ---- Editar una categoría -----------------------------------------------
    const editarCatModal = document.getElementById('editar-categoria-modal');
    let categoriaEditando = null;

    function abrirEditarCategoria(c) {
        categoriaEditando = c;
        const cualEl = document.getElementById('editar-categoria-cual');
        if (cualEl) cualEl.textContent = c.nombre;
        const nombreInput = document.getElementById('editar-categoria-nombre');
        if (nombreInput) nombreInput.value = c.nombre || '';
        const tipoSelect = document.getElementById('editar-categoria-tipo');
        if (tipoSelect) tipoSelect.value = c.tipo || 'BEBIDA';
        const descInput = document.getElementById('editar-categoria-descripcion');
        if (descInput) descInput.value = c.descripcion || '';

        if (editarCatModal) editarCatModal.classList.remove('hide');
        if (nombreInput) nombreInput.focus();
    }

    function cerrarEditarCategoria() {
        if (editarCatModal) editarCatModal.classList.add('hide');
        categoriaEditando = null;
    }

    async function guardarEdicionCategoria() {
        if (!categoriaEditando) return;
        const idCat = categoriaEditando.id_categoria;
        const boton = document.getElementById('editar-categoria-guardar');
        if (boton) boton.disabled = true;

        const nombreInput = document.getElementById('editar-categoria-nombre');
        const tipoSelect = document.getElementById('editar-categoria-tipo');
        const descInput = document.getElementById('editar-categoria-descripcion');

        const nuevoNombre = nombreInput ? nombreInput.value.trim() : '';
        const nuevoTipo = tipoSelect ? tipoSelect.value : 'BEBIDA';
        const nuevaDesc = descInput ? descInput.value.trim() : '';

        if (!nuevoNombre) {
            notify('La categoría necesita un nombre.', 'error');
            if (boton) boton.disabled = false;
            return;
        }

        cerrarEditarCategoria();
        try {
            const res = await fetch('/api/admin/categorias/' + idCat, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nombre: nuevoNombre,
                    tipo: nuevoTipo,
                    descripcion: nuevaDesc,
                    id_admin: currentUser ? currentUser.id_admin : 1
                })
            });
            let data = {};
            try { data = await res.json(); } catch (_) {}
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo guardar los cambios.', 'error');
                return;
            }
            notify(data.message || `Categoría "${nuevoNombre}" actualizada.`, 'ok');
            await Promise.all([cargarCatalogoAdmin(), loadCatalogSetup(), fetchProductsAndMenu()]);
        } catch (err) {
            console.error('Error al editar categoría:', err);
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        } finally {
            if (boton) boton.disabled = false;
        }
    }

    document.getElementById('editar-categoria-cerrar')?.addEventListener('click', cerrarEditarCategoria);
    document.getElementById('editar-categoria-guardar')?.addEventListener('click', guardarEdicionCategoria);
    editarCatModal?.addEventListener('click', e => {
        if (e.target === editarCatModal) cerrarEditarCategoria();
    });


    // ---- Personal -----------------------------------------------------------
    // ---- Personal: Cajeros, Meseros & Encargados ----------------------------
    let personalAdmin = { cajeros: [], meseros: [], encargados: [] };

    async function cargarPersonalAdmin() {
        try {
            const res = await fetch('/api/admin/personal');
            personalAdmin = await res.json();
        } catch (err) {
            personalAdmin = { cajeros: [], meseros: [], encargados: [] };
        }
        pintarCajeros();
        pintarMeseros();
        pintarEncargados();
    }

    async function alternarCajero(c) {
        try {
            const nuevoActivo = c.activo ? 0 : 1;
            const res = await fetch('/api/admin/cajeros/' + c.id_cajero + '/estado', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    activo: nuevoActivo,
                    id_admin: currentUser ? currentUser.id_admin : 1
                })
            });
            let data = {};
            try { data = await res.json(); } catch (_) {}

            if (!res.ok || !data.success) {
                notify(data.message || ('Error del servidor (' + res.status + ').'), 'error');
                return;
            }
            notify(nuevoActivo ? `Cajero "${c.nombre}" activado.` : `Cajero "${c.nombre}" desactivado.`, 'ok');
            await Promise.all([cargarPersonalAdmin(), loadPersonalSetup()]);
        } catch (err) {
            console.error('Error al alternar cajero:', err);
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    }

    async function alternarMesero(m) {
        try {
            const nuevoActivo = m.activo ? 0 : 1;
            const res = await fetch('/api/admin/meseros/' + m.id_mesero + '/estado', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    activo: nuevoActivo,
                    id_admin: currentUser ? currentUser.id_admin : 1
                })
            });
            let data = {};
            try { data = await res.json(); } catch (_) {}

            if (!res.ok || !data.success) {
                notify(data.message || ('Error del servidor (' + res.status + ').'), 'error');
                return;
            }
            notify(nuevoActivo ? `Mesero "${m.nombre}" activado.` : `Mesero "${m.nombre}" desactivado.`, 'ok');
            await Promise.all([cargarPersonalAdmin(), loadPersonalSetup()]);
        } catch (err) {
            console.error('Error al alternar mesero:', err);
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    }

    // ---- Editar Cajero Modal ------------------------------------------------
    const editarCajeroModal = document.getElementById('editar-cajero-modal');
    let cajeroEditando = null;

    function abrirEditarCajero(c) {
        cajeroEditando = c;
        const cualEl = document.getElementById('editar-cajero-cual');
        if (cualEl) cualEl.textContent = `${c.nombre} (@${c.usuario})`;
        const nombreInput = document.getElementById('editar-cajero-nombre');
        if (nombreInput) nombreInput.value = c.nombre || '';
        const userInput = document.getElementById('editar-cajero-usuario');
        if (userInput) userInput.value = c.usuario || '';
        const passInput = document.getElementById('editar-cajero-password');
        if (passInput) passInput.value = '';

        if (editarCajeroModal) editarCajeroModal.classList.remove('hide');
        if (nombreInput) nombreInput.focus();
    }

    function cerrarEditarCajero() {
        if (editarCajeroModal) editarCajeroModal.classList.add('hide');
        cajeroEditando = null;
    }

    async function guardarEdicionCajero() {
        if (!cajeroEditando) return;
        const idCajero = cajeroEditando.id_cajero;
        const boton = document.getElementById('editar-cajero-guardar');
        if (boton) boton.disabled = true;

        const nombre = (document.getElementById('editar-cajero-nombre')?.value || '').trim();
        const usuario = (document.getElementById('editar-cajero-usuario')?.value || '').trim();
        const password = (document.getElementById('editar-cajero-password')?.value || '').trim();

        if (!nombre) {
            notify('El nombre no puede estar vacío.', 'error');
            if (boton) boton.disabled = false;
            return;
        }
        if (!usuario) {
            notify('El usuario no puede estar vacío.', 'error');
            if (boton) boton.disabled = false;
            return;
        }

        cerrarEditarCajero();
        try {
            const body = {
                nombre,
                usuario,
                id_admin: currentUser ? currentUser.id_admin : 1
            };
            if (password) body.password = password;

            const res = await fetch('/api/admin/cajeros/' + idCajero, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            let data = {};
            try { data = await res.json(); } catch (_) {}
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo guardar los cambios del cajero.', 'error');
                return;
            }
            notify(data.message || `Cajero "${nombre}" actualizado.`, 'ok');
            await Promise.all([cargarPersonalAdmin(), loadPersonalSetup()]);
        } catch (err) {
            console.error('Error al editar cajero:', err);
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        } finally {
            if (boton) boton.disabled = false;
        }
    }

    document.getElementById('editar-cajero-cerrar')?.addEventListener('click', cerrarEditarCajero);
    document.getElementById('editar-cajero-guardar')?.addEventListener('click', guardarEdicionCajero);
    editarCajeroModal?.addEventListener('click', e => {
        if (e.target === editarCajeroModal) cerrarEditarCajero();
    });

    // ---- Editar Mesero Modal ------------------------------------------------
    const editarMeseroModal = document.getElementById('editar-mesero-modal');
    let meseroEditando = null;

    function abrirEditarMesero(m) {
        meseroEditando = m;
        const cualEl = document.getElementById('editar-mesero-cual');
        if (cualEl) cualEl.textContent = `${m.nombre} (PIN: ${m.pin || '••••'})`;

        // Llenar selector de cajeros
        const selCajero = document.getElementById('editar-mesero-cajero');
        if (selCajero) {
            selCajero.innerHTML = '';
            (personalAdmin.cajeros || []).filter(c => c.activo !== 0).forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id_cajero;
                opt.textContent = `${c.nombre} (${c.usuario})`;
                if (c.id_cajero === m.id_cajero || c.nombre === m.cajero) {
                    opt.selected = true;
                }
                selCajero.appendChild(opt);
            });
        }

        const nombreInput = document.getElementById('editar-mesero-nombre');
        if (nombreInput) nombreInput.value = m.nombre || '';
        const pinInput = document.getElementById('editar-mesero-pin');
        if (pinInput) pinInput.value = m.pin || m.password || '';

        if (editarMeseroModal) editarMeseroModal.classList.remove('hide');
        if (nombreInput) nombreInput.focus();
    }

    function cerrarEditarMesero() {
        if (editarMeseroModal) editarMeseroModal.classList.add('hide');
        meseroEditando = null;
    }

    async function guardarEdicionMesero() {
        if (!meseroEditando) return;
        const idMesero = meseroEditando.id_mesero;
        const boton = document.getElementById('editar-mesero-guardar');
        if (boton) boton.disabled = true;

        const id_cajero = document.getElementById('editar-mesero-cajero')?.value;
        const nombre = (document.getElementById('editar-mesero-nombre')?.value || '').trim();
        const pin = (document.getElementById('editar-mesero-pin')?.value || '').trim();

        if (!nombre) {
            notify('El nombre no puede estar vacío.', 'error');
            if (boton) boton.disabled = false;
            return;
        }
        if (!pin) {
            notify('El PIN no puede estar vacío.', 'error');
            if (boton) boton.disabled = false;
            return;
        }

        cerrarEditarMesero();
        try {
            const res = await fetch('/api/admin/meseros/' + idMesero, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id_cajero: Number(id_cajero),
                    nombre,
                    pin,
                    password: pin,
                    id_admin: currentUser ? currentUser.id_admin : 1
                })
            });
            let data = {};
            try { data = await res.json(); } catch (_) {}
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo guardar los cambios del mesero.', 'error');
                return;
            }
            notify(data.message || `Mesero "${nombre}" actualizado.`, 'ok');
            await Promise.all([cargarPersonalAdmin(), loadPersonalSetup()]);
        } catch (err) {
            console.error('Error al editar mesero:', err);
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        } finally {
            if (boton) boton.disabled = false;
        }
    }

    document.getElementById('editar-mesero-cerrar')?.addEventListener('click', cerrarEditarMesero);
    document.getElementById('editar-mesero-guardar')?.addEventListener('click', guardarEdicionMesero);
    editarMeseroModal?.addEventListener('click', e => {
        if (e.target === editarMeseroModal) cerrarEditarMesero();
    });

    // ---- Editar Encargado Modal ---------------------------------------------
    const editarEncargadoModal = document.getElementById('editar-encargado-modal');
    let encargadoEditando = null;

    function abrirEditarEncargado(enc) {
        encargadoEditando = enc;
        const cualEl = document.getElementById('editar-encargado-cual');
        if (cualEl) cualEl.textContent = `${enc.nombre} (@${enc.usuario})`;

        const nombreInput = document.getElementById('editar-encargado-nombre');
        if (nombreInput) nombreInput.value = enc.nombre || '';
        const userInput = document.getElementById('editar-encargado-usuario');
        if (userInput) userInput.value = enc.usuario || '';
        const passInput = document.getElementById('editar-encargado-password');
        if (passInput) passInput.value = '';

        if (editarEncargadoModal) editarEncargadoModal.classList.remove('hide');
        if (nombreInput) nombreInput.focus();
    }

    function cerrarEditarEncargado() {
        if (editarEncargadoModal) editarEncargadoModal.classList.add('hide');
        encargadoEditando = null;
    }

    async function guardarEdicionEncargado() {
        if (!encargadoEditando) return;
        const idAdmin = encargadoEditando.id_admin;
        const boton = document.getElementById('editar-encargado-guardar');
        if (boton) boton.disabled = true;

        const nombre = (document.getElementById('editar-encargado-nombre')?.value || '').trim();
        const usuario = (document.getElementById('editar-encargado-usuario')?.value || '').trim();
        const password = (document.getElementById('editar-encargado-password')?.value || '').trim();

        if (!nombre) {
            notify('El nombre no puede estar vacío.', 'error');
            if (boton) boton.disabled = false;
            return;
        }
        if (!usuario) {
            notify('El usuario no puede estar vacío.', 'error');
            if (boton) boton.disabled = false;
            return;
        }

        cerrarEditarEncargado();
        try {
            const body = {
                nombre,
                usuario,
                id_admin: currentUser ? currentUser.id_admin : 1
            };
            if (password) body.password = password;

            const res = await fetch('/api/admin/encargados/' + idAdmin, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            let data = {};
            try { data = await res.json(); } catch (_) {}
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo guardar los cambios del encargado.', 'error');
                return;
            }
            notify(data.message || `Encargado "${nombre}" actualizado.`, 'ok');
            await cargarPersonalAdmin();
        } catch (err) {
            console.error('Error al editar encargado:', err);
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        } finally {
            if (boton) boton.disabled = false;
        }
    }

    document.getElementById('editar-encargado-cerrar')?.addEventListener('click', cerrarEditarEncargado);
    document.getElementById('editar-encargado-guardar')?.addEventListener('click', guardarEdicionEncargado);
    editarEncargadoModal?.addEventListener('click', e => {
        if (e.target === editarEncargadoModal) cerrarEditarEncargado();
    });

    function pintarCajeros() {
        const cont = document.getElementById('lista-cajeros');
        if (!cont) return;
        const inputBuscar = document.getElementById('buscar-cajero');
        const filtro = (inputBuscar ? inputBuscar.value : '').trim().toLowerCase();
        const todos = (personalAdmin.cajeros || []).filter(c => c.activo !== 0);
        const lista = filtro
            ? todos.filter(c => (c.nombre || '').toLowerCase().includes(filtro) ||
                                (c.usuario || '').toLowerCase().includes(filtro))
            : todos;

        const contEl = document.getElementById('cont-cajeros');
        if (contEl) {
            contEl.textContent = filtro ? lista.length + ' de ' + todos.length : todos.length;
        }

        if (!lista.length) {
            return pintarVacio(cont, filtro ? 'Ningún cajero con ese nombre o usuario.' : 'Todavía no hay cajeros.');
        }

        cont.innerHTML = '';
        lista.forEach(c => {
            const partes = [c.usuario];
            if (c.meseros) partes.push(c.meseros + (c.meseros === 1 ? ' mesero' : ' meseros'));
            const fila = filaLista({
                titulo: c.nombre,
                detalle: partes.join(' · '),
                insignia: c.comandas > 0 ? c.comandas + (c.comandas === 1 ? ' comanda' : ' comandas') : '',
                inactivo: false,
                onEditar: () => abrirEditarCajero(c),
                onBorrar: () => borrar(
                    '/api/admin/cajeros/' + c.id_cajero,
                    c.comandas > 0
                        ? c.nombre + ' ya cobró comandas.\n\nDejará de poder entrar, pero sus ventas seguirán ' +
                          'en el cierre. ¿Eliminarlo de la lista?'
                        : '¿Eliminar al cajero ' + c.nombre + '?',
                    () => { cargarPersonalAdmin(); loadPersonalSetup(); })
            });
            cont.appendChild(fila);
        });
    }

    function pintarMeseros() {
        const cont = document.getElementById('lista-meseros');
        if (!cont) return;
        const filtro = (document.getElementById('buscar-mesero').value || '')
            .trim().toLowerCase();
        const todos = (personalAdmin.meseros || []).filter(m => m.activo !== 0);
        // Se busca también por PIN: en mitad del evento, lo que se olvida es el
        // número, no el nombre.
        const lista = filtro
            ? todos.filter(m => (m.nombre || '').toLowerCase().includes(filtro) ||
                                String(m.pin || '').includes(filtro))
            : todos;

        document.getElementById('cont-meseros').textContent =
            filtro ? lista.length + ' de ' + todos.length : todos.length;

        if (!lista.length) {
            return pintarVacio(cont, filtro ? 'Ningún mesero con eso.' : 'Todavía no hay meseros.');
        }

        cont.innerHTML = '';
        // Agrupados por cajero: es como se reparte el trabajo en la barra, y
        // así se ve de un vistazo quién lleva cinco meseros y quién ninguno.
        agrupar(lista, m => m.cajero).forEach((meseros, cajero) => {
            cont.appendChild(cabeceraGrupo(cajero, meseros.length));
            meseros.forEach(m => {
                const fila = filaLista({
                    titulo: m.nombre,
                    detalle: 'PIN ' + (m.pin || m.password || '••••'),
                    insignia: m.comandas > 0 ? m.comandas + (m.comandas === 1 ? ' comanda' : ' comandas') : '',
                    inactivo: false,
                    onEditar: () => abrirEditarMesero(m),
                    onBorrar: () => borrar(
                        '/api/admin/meseros/' + m.id_mesero,
                        m.comandas > 0
                            ? m.nombre + ' ya tiene comandas.\n\nSu PIN dejará de funcionar, pero sus ventas seguirán ' +
                              'en el cierre. ¿Eliminarlo de la lista?'
                            : '¿Eliminar al mesero ' + m.nombre + '?',
                        () => { cargarPersonalAdmin(); loadPersonalSetup(); })
                });
                cont.appendChild(fila);
            });
        });
    }

    function pintarEncargados() {
        const cont = document.getElementById('lista-encargados');
        if (!cont) return;
        const inputBuscar = document.getElementById('buscar-encargado');
        const filtro = (inputBuscar ? inputBuscar.value : '').trim().toLowerCase();
        const todos = (personalAdmin.encargados || []).filter(e => e.activo !== 0);
        const lista = filtro
            ? todos.filter(e => (e.nombre || '').toLowerCase().includes(filtro) ||
                                (e.usuario || '').toLowerCase().includes(filtro))
            : todos;

        const contEl = document.getElementById('cont-encargados');
        if (contEl) {
            contEl.textContent = filtro ? lista.length + ' de ' + todos.length : todos.length;
        }

        if (!lista.length) {
            return pintarVacio(cont, filtro ? 'Ningún encargado con ese nombre o usuario.' : 'Todavía no hay encargados.');
        }

        cont.innerHTML = '';
        lista.forEach(enc => {
            const fila = filaLista({
                titulo: enc.nombre,
                detalle: '@' + enc.usuario + (enc.movimientos ? ` · ${enc.movimientos} mov. de stock` : ''),
                insignia: 'INVENTARIO',
                inactivo: false,
                onEditar: () => abrirEditarEncargado(enc),
                onBorrar: () => borrar(
                    '/api/admin/encargados/' + enc.id_admin,
                    enc.movimientos > 0
                        ? enc.nombre + ' ya registró movimientos en inventario.\n\nDejará de poder entrar, pero su historial de stock se conservará. ¿Eliminarlo de la lista?'
                        : '¿Eliminar al encargado ' + enc.nombre + '?',
                    () => { cargarPersonalAdmin(); })
            });
            cont.appendChild(fila);
        });
    }

    document.getElementById('buscar-producto-cat').addEventListener('input', pintarProductosAdmin);
    const inputBuscarCajero = document.getElementById('buscar-cajero');
    if (inputBuscarCajero) inputBuscarCajero.addEventListener('input', pintarCajeros);
    document.getElementById('buscar-mesero').addEventListener('input', pintarMeseros);
    const inputBuscarEncargado = document.getElementById('buscar-encargado');
    if (inputBuscarEncargado) inputBuscarEncargado.addEventListener('input', pintarEncargados);

    // TAB: PERSONAL & BARRAS SETUP
    // `mantenerCajero` conserva el cajero elegido al repintar el desplegable:
    // al dar de alta varios meseros seguidos, todos son del mismo.
    async function loadPersonalSetup(mantenerCajero) {
        try {
            const response = await fetch('/api/admin/configuracion');
            const data = await response.json();

            // La barra no se elige: es la de este servidor. Se enseña sólo
            // para que quede claro dónde va a poder cobrar el cajero.
            pintarBarraDelCajero();

            // Populate Mesero's Cajero selector
            const mesCajero = document.getElementById('mes-cajero');
            const elegido = mantenerCajero || mesCajero.value;
            mesCajero.innerHTML = '<option value="" disabled>Seleccione cajero...</option>';
            data.cajeros.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id_cajero;
                opt.textContent = `${c.nombre} (${c.usuario})`;
                mesCajero.appendChild(opt);
            });
            // Se vuelve a poner el que estaba; si ya no existe, se queda en el
            // aviso de elegir uno.
            mesCajero.value = elegido || '';
            if (!mesCajero.value) mesCajero.selectedIndex = 0;
        } catch (err) {
            console.error(err);
        }
    }

    // La barra de esta instancia, tal como se rotuló en Datos del evento. Ya no
    // se crean barras desde el panel: un servidor es una barra.
    function pintarBarraDelCajero() {
        const casilla = document.getElementById('caj-barra');
        if (casilla) casilla.value = instancia.nombre || '—';
    }

    // Form: Create Cajero
    document.getElementById('form-create-cajero').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nombre = document.getElementById('caj-name').value;
        const usuario = document.getElementById('caj-user').value;
        const password = document.getElementById('caj-pass').value;

        document.getElementById('form-create-cajero').reset();

        const tempCajero = {
            id_cajero: Date.now(),
            nombre: nombre,
            usuario: usuario,
            meseros: 0,
            comandas: 0,
            activo: 1
        };
        if (!personalAdmin) personalAdmin = { cajeros: [], meseros: [] };
        if (!personalAdmin.cajeros) personalAdmin.cajeros = [];
        personalAdmin.cajeros.push(tempCajero);
        pintarCajeros();

        try {
            const response = await fetch('/api/admin/cajeros', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre, usuario, password, id_admin: currentUser ? currentUser.id_admin : 1, id_evento: currentUser ? currentUser.id_evento : 1 })
            });
            const data = await response.json();

            if (data.success) {
                notify('Cajero registrado.', 'ok');
                tempCajero.id_cajero = data.id_cajero;
                await Promise.all([loadPersonalSetup(), cargarPersonalAdmin()]);
            } else {
                notify(data.message || 'No se pudo completar la operación.', 'error');
                const idx = personalAdmin.cajeros.indexOf(tempCajero);
                if (idx !== -1) { personalAdmin.cajeros.splice(idx, 1); pintarCajeros(); }
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    });

    // Form: Create Mesero
    document.getElementById('form-create-mesero').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id_cajero = document.getElementById('mes-cajero').value;
        const nombre = document.getElementById('mes-name').value;
        const usuario = document.getElementById('mes-user').value;
        const password = document.getElementById('mes-pass').value;

        ['mes-name', 'mes-user', 'mes-pass'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const nameEl = document.getElementById('mes-name');
        if (nameEl) nameEl.focus();

        const sel = document.getElementById('mes-cajero');
        const cajeroNombre = sel ? (sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.replace(/\s*\([^)]*\)/, '') : 'Cajero') : 'Cajero';
        const tempMesero = {
            id_mesero: Date.now(),
            id_cajero: Number(id_cajero),
            cajero: cajeroNombre,
            nombre: nombre,
            usuario: usuario,
            pin: password,
            comandas: 0,
            activo: 1
        };
        if (!personalAdmin) personalAdmin = { cajeros: [], meseros: [] };
        if (!personalAdmin.meseros) personalAdmin.meseros = [];
        personalAdmin.meseros.push(tempMesero);
        pintarMeseros();

        try {
            const response = await fetch('/api/admin/meseros', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_cajero, nombre, usuario, password, id_admin: currentUser ? currentUser.id_admin : 1, id_evento: currentUser ? currentUser.id_evento : 1 })
            });
            const data = await response.json();

            if (data.success) {
                notify('Mesero registrado.', 'ok');
                tempMesero.id_mesero = data.id_mesero;
                await Promise.all([loadPersonalSetup(id_cajero), cargarPersonalAdmin()]);
            } else {
                notify(data.message || 'No se pudo completar la operación.', 'error');
                const idx = personalAdmin.meseros.indexOf(tempMesero);
                if (idx !== -1) { personalAdmin.meseros.splice(idx, 1); pintarMeseros(); }
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    });

    // Form: Create Encargado
    document.getElementById('form-create-encargado')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nombre = (document.getElementById('enc-name')?.value || '').trim();
        const usuario = (document.getElementById('enc-user')?.value || '').trim();
        const password = (document.getElementById('enc-pass')?.value || '').trim();

        document.getElementById('form-create-encargado').reset();

        const tempEnc = {
            id_admin: Date.now(),
            nombre: nombre,
            usuario: usuario,
            rol: 'ENCARGADO',
            movimientos: 0,
            activo: 1
        };
        if (!personalAdmin) personalAdmin = { cajeros: [], meseros: [], encargados: [] };
        if (!personalAdmin.encargados) personalAdmin.encargados = [];
        personalAdmin.encargados.push(tempEnc);
        pintarEncargados();

        try {
            const response = await fetch('/api/admin/encargados', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nombre,
                    usuario,
                    password,
                    id_admin: currentUser ? currentUser.id_admin : 1,
                    id_evento: currentUser ? currentUser.id_evento : 1
                })
            });
            const data = await response.json();

            if (data.success) {
                notify(data.message || 'Encargado registrado.', 'ok');
                tempEnc.id_admin = data.id_admin;
                await cargarPersonalAdmin();
            } else {
                notify(data.message || 'No se pudo completar la operación.', 'error');
                const idx = personalAdmin.encargados.indexOf(tempEnc);
                if (idx !== -1) { personalAdmin.encargados.splice(idx, 1); pintarEncargados(); }
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    });

    // TAB: ADJUST STOCK SETUP
    // ==========================================
    // INGRESO DE MERCANCÍA (COMPRA O TRASPASO RECIBIDO)
    // ==========================================
    // Dos orígenes y hay que distinguirlos: lo que se compra a un proveedor
    // costó dinero, lo que llega de otra barra ya estaba pagado. Mezclarlos
    // haría imposible saber cuánto se gastó en mercancía esa noche.
    let ingresoMotivo = 'COMPRA';
    let ingresoPendientes = [];

    function pintarIngresoPendientes() {
        const caja = document.getElementById('ingreso-lista');
        if (!caja) return;
        caja.innerHTML = '';

        // El botón dice cuántos lleva la lista: es lo que aclara que guardar
        // registra TODO lo añadido, no sólo lo que se ve escrito arriba.
        const guardar = document.getElementById('ingreso-guardar');
        if (guardar) {
            guardar.textContent = ingresoPendientes.length
                ? 'Guardar ingreso (' + ingresoPendientes.length + ')'
                : 'Guardar ingreso';
        }
        ingresoPendientes.forEach((p, i) => {
            const fila = document.createElement('div');
            fila.className = 'mover-pendiente';
            const txt = document.createElement('span');
            txt.textContent = p.cantidad + ' × ' + p.nombre;
            fila.appendChild(txt);
            const quitar = document.createElement('button');
            quitar.type = 'button';
            quitar.className = 'mover-quitar';
            quitar.textContent = '✕';
            quitar.setAttribute('aria-label', 'Quitar ' + p.nombre);
            quitar.addEventListener('click', () => {
                ingresoPendientes.splice(i, 1);
                pintarIngresoPendientes();
            });
            fila.appendChild(quitar);
            caja.appendChild(fila);
        });
    }

    function apuntarIngreso() {
        const sel = document.getElementById('ingreso-producto');
        const id = parseInt(sel.value, 10);
        const n = parseInt(document.getElementById('ingreso-unidades').value, 10);

        if (!id) { notify('Elige el producto.', 'warn'); return false; }
        if (!Number.isInteger(n) || n <= 0) {
            notify('Pon cuántas unidades llegaron.', 'warn');
            return false;
        }
        ingresoPendientes.push({
            id_producto: id,
            nombre: sel.options[sel.selectedIndex].textContent,
            cantidad: n
        });
        pintarIngresoPendientes();
        document.getElementById('ingreso-unidades').value = '';
        return true;
    }

    async function guardarIngreso() {
        const sel = document.getElementById('ingreso-producto');
        const id = sel ? parseInt(sel.value, 10) : 0;
        const uInput = document.getElementById('ingreso-unidades');
        const n = uInput ? parseInt(uInput.value, 10) : 0;
        if (id && Number.isInteger(n) && n > 0) {
            apuntarIngreso();
        }

        if (!ingresoPendientes || ingresoPendientes.length === 0) {
            notify('Añade al menos un producto a la lista antes de guardar.', 'warn');
            return;
        }

        const origen = document.getElementById('ingreso-origen').value.trim();
        if (!origen) {
            notify(ingresoMotivo === 'COMPRA'
                ? 'Escribe a qué proveedor se le compró.'
                : 'Escribe de qué barra llega.', 'warn');
            return;
        }

        const boton = document.getElementById('ingreso-guardar');
        boton.disabled = true;
        try {
            const res = await fetch('/api/traspaso', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tipo: 'ENTRADA',
                    motivo: ingresoMotivo,
                    contraparte: origen,
                    observaciones: document.getElementById('ingreso-nota').value.trim(),
                    id_admin: currentUser ? currentUser.id_admin : null,
                    items: ingresoPendientes.map(p => ({ id_producto: p.id_producto, cantidad: p.cantidad }))
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo registrar el ingreso.', 'error', 7000);
                return;
            }

            notify(data.message, 'ok', 6000);
            ingresoPendientes = [];
            pintarIngresoPendientes();
            document.getElementById('ingreso-nota').value = '';
            document.getElementById('ingreso-unidades').value = '';
            cargarTraspasos();
            loadStockSetup();
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        } finally {
            boton.disabled = false;
        }
    }

    document.querySelectorAll('.ingreso-tipo').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.ingreso-tipo').forEach(b => b.classList.remove('activa'));
            btn.classList.add('activa');
            ingresoMotivo = btn.dataset.motivo;
            const etiqueta = document.getElementById('ingreso-origen-label');
            const campo = document.getElementById('ingreso-origen');
            if (ingresoMotivo === 'COMPRA') {
                etiqueta.textContent = 'Proveedor';
                campo.placeholder = 'Ej. Distribuidora Central';
            } else {
                etiqueta.textContent = 'Barra de origen';
                campo.placeholder = 'Ej. Barra VIP';
            }
        });
    });

    document.getElementById('ingreso-otro').addEventListener('click', () => { apuntarIngreso(); });
    document.getElementById('ingreso-guardar').addEventListener('click', guardarIngreso);

    // ---- Historial de movimientos de mercancía -----------------------------
    async function cargarTraspasos() {
        const caja = document.getElementById('lista-traspasos');
        if (!caja) return;
        let data;
        try {
            data = await (await fetch('/api/traspasos')).json();
        } catch (err) {
            return pintarVacio(caja, 'No se pudo leer el historial.');
        }

        const lista = data.traspasos || [];
        document.getElementById('cont-traspasos').textContent = lista.length;
        if (!lista.length) {
            return pintarVacio(caja, 'Todavía no hay entradas ni salidas de mercancía.');
        }

        caja.innerHTML = '';
        lista.forEach(t => {
            const sale = t.tipo === 'SALIDA';
            const fila = document.createElement('div');
            fila.className = 'lista-fila';

            const flecha = document.createElement('span');
            flecha.className = 'traspaso-flecha ' + (sale ? 'sale' : 'entra');
            flecha.textContent = sale ? '↗' : '↙';
            flecha.title = sale ? 'Salió de esta barra' : 'Entró a esta barra';
            fila.appendChild(flecha);

            const texto = document.createElement('div');
            texto.className = 'lista-texto';
            const nombre = document.createElement('span');
            nombre.className = 'lista-nombre';
            nombre.textContent = (sale ? 'A ' : (t.motivo === 'COMPRA' ? 'Compra a ' : 'De ')) + t.contraparte;
            texto.appendChild(nombre);
            const sub = document.createElement('span');
            sub.className = 'lista-detalle';
            sub.textContent = ['#' + t.id_traspaso, t.fecha_hora, t.cajero || '']
                .filter(Boolean).join(' · ');
            texto.appendChild(sub);
            fila.appendChild(texto);

            const ins = document.createElement('span');
            ins.className = 'lista-insignia';
            ins.textContent = t.unidades + (t.unidades === 1 ? ' unidad' : ' unidades');
            fila.appendChild(ins);

            caja.appendChild(fila);
        });
    }

    // ==========================================
    // GESTIÓN DE STOCK POR TARJETAS (ADMIN)
    // ==========================================
    let adminStockProducts = [];
    let adminStockCategories = [];
    let adminStockActiveCategory = 'all';
    let adminStockSearchQuery = '';
    let adminStockPage = 1;
    let currentStockModalProduct = null;
    let currentStockModalType = 'ENTRADA';

    function getStockCardsPerPage() {
        const grid = document.getElementById('admin-stock-cards-grid');
        const main = document.querySelector('#admin-view .admin-main');

        // Si ya hay tarjetas en pantalla, medir las columnas reales físicamente
        if (grid && grid.children.length > 0 && grid.clientWidth > 0) {
            const cards = Array.from(grid.querySelectorAll('.admin-stock-card'));
            if (cards.length > 0) {
                const top0 = cards[0].offsetTop;
                const row1 = cards.filter(c => Math.abs(c.offsetTop - top0) < 12);
                if (row1.length > 0) {
                    return Math.max(2, row1.length * 2);
                }
            }
        }

        let cols = 6;
        let width = 0;

        if (grid && grid.clientWidth > 0) {
            width = grid.clientWidth;
            const comp = window.getComputedStyle(grid).gridTemplateColumns;
            if (comp && comp !== 'none') {
                const tracks = comp.trim().split(/\s+/).filter(Boolean);
                if (tracks.length > 0) {
                    return Math.max(2, tracks.length * 2);
                }
            }
        } else if (main && main.clientWidth > 0) {
            width = main.clientWidth - 48;
        } else {
            width = (window.innerWidth || 1366) - 280;
        }

        // Cada columna en .admin-stock-grid mide min 220px con gap 20px
        if (width > 0) {
            cols = Math.max(1, Math.floor((width + 20) / 240));
        }

        // Retorna EXACTAMENTE 2 filas completas
        return Math.max(2, cols * 2);
    }

    async function loadStockSetup() {
        try {
            const response = await fetch('/api/productos');
            const data = await response.json();

            adminStockProducts = data.productos || [];
            adminStockCategories = data.categorias || [];

            // Actualizar selectores de albarán si existen
            ['ingreso-producto'].forEach(id => {
                const select = document.getElementById(id);
                if (!select) return;
                select.innerHTML = '<option value="" disabled selected>Seleccione producto...</option>';
                adminStockProducts.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.id_producto;
                    opt.textContent = `${p.nombre} (Stock: ${p.stock_actual})`;
                    select.appendChild(opt);
                });
            });

            renderAdminStockCategories();
            renderAdminStockGrid();
            cargarTraspasos();
        } catch (err) {
            console.error("Error al cargar stock:", err);
            notify('Error al cargar inventario.', 'error');
        }
    }

    function renderAdminStockCategories() {
        const catContainer = document.getElementById('admin-stock-category-pills');
        if (!catContainer) return;
        catContainer.innerHTML = '';

        const allBtn = document.createElement('button');
        allBtn.type = 'button';
        allBtn.className = `category-btn ${adminStockActiveCategory === 'all' ? 'active' : ''}`;
        allBtn.textContent = '🍹 Todos';
        allBtn.addEventListener('click', () => {
            adminStockActiveCategory = 'all';
            adminStockPage = 1;
            document.querySelectorAll('#admin-stock-category-pills .category-btn').forEach(b => b.classList.remove('active'));
            allBtn.classList.add('active');
            renderAdminStockGrid();
        });
        catContainer.appendChild(allBtn);

        const icons = { 'BEBIDA': '🍺', 'COMIDA': '🍔', 'OTRO': '🏷️' };
        adminStockCategories.forEach(cat => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `category-btn ${adminStockActiveCategory === cat.id_categoria ? 'active' : ''}`;
            btn.textContent = `${icons[cat.tipo] || '📦'} ${cat.nombre}`;
            btn.addEventListener('click', () => {
                adminStockActiveCategory = cat.id_categoria;
                adminStockPage = 1;
                document.querySelectorAll('#admin-stock-category-pills .category-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderAdminStockGrid();
            });
            catContainer.appendChild(btn);
        });
    }

    function getStockCardsPerPage() {
        const grid = document.getElementById('admin-stock-cards-grid');
        const main = document.querySelector('#admin-view .admin-main');

        let width = 0;
        if (grid && grid.clientWidth > 0) {
            width = grid.clientWidth;
        } else if (main && main.clientWidth > 0) {
            width = main.clientWidth - 48;
        } else {
            width = (window.innerWidth || 1024) - 260;
        }

        // Cada columna en .admin-stock-grid mide min 210px con gap 14px
        const cols = Math.max(1, Math.floor((width + 14) / 224));
        // EXACTAMENTE 2 FILAS
        return Math.max(2, cols * 2);
    }

    function renderAdminStockGrid() {
        const grid = document.getElementById('admin-stock-cards-grid');
        const summaryText = document.getElementById('admin-stock-summary-text');
        const paginationContainer = document.getElementById('admin-stock-pagination');
        if (!grid) return;

        const search = (adminStockSearchQuery || '').toLowerCase().trim();
        const filtered = adminStockProducts.filter(p => {
            const matchCat = adminStockActiveCategory === 'all' || p.id_categoria === adminStockActiveCategory;
            const matchSearch = !search || p.nombre.toLowerCase().includes(search) || (p.descripcion && p.descripcion.toLowerCase().includes(search));
            return matchCat && matchSearch;
        });

        const totalProds = adminStockProducts.length;
        const conStock = adminStockProducts.filter(p => p.stock_actual > 0).length;
        const agotados = adminStockProducts.filter(p => p.stock_actual <= 0).length;

        if (summaryText) {
            summaryText.innerHTML = `<strong>${totalProds}</strong> productos en total · <span style="color: #34d399; font-weight: 600;">${conStock} con stock</span> · <span style="color: #f87171; font-weight: 600;">${agotados} agotados</span>`;
        }

        if (filtered.length === 0) {
            grid.innerHTML = `<div class="empty-cart-msg" style="grid-column: 1 / -1; padding: 40px 20px; text-align: center;">No se encontraron productos que coincidan con la búsqueda.</div>`;
            renderAdminStockPagination(0, 0);
            return;
        }

        // Paginación a exactamente 2 filas de tarjetas
        const perPage = getStockCardsPerPage();
        const totalItems = filtered.length;
        let totalPages = Math.max(1, Math.ceil(totalItems / perPage));
        if (adminStockPage > totalPages) adminStockPage = totalPages;
        if (adminStockPage < 1) adminStockPage = 1;

        const startIdx = (adminStockPage - 1) * perPage;
        const pagedProducts = filtered.slice(startIdx, startIdx + perPage);

        const catMap = {};
        adminStockCategories.forEach(c => { catMap[c.id_categoria] = c.nombre; });

        grid.innerHTML = '';

        pagedProducts.forEach(p => {
            const card = document.createElement('div');
            card.className = 'admin-stock-card';
            card.dataset.id = p.id_producto;

            const catNombre = catMap[p.id_categoria] || 'General';
            const tieneFoto = Boolean(p.tiene_foto);
            const fotoSrc = urlFoto(p);

            const visibleStock = Math.max(0, p.stock_actual);
            const tope = p.stock_tope || p.stock_actual || 10;
            const pct = tope > 0 ? Math.min(100, Math.max(0, Math.round((visibleStock / tope) * 100))) : (visibleStock > 0 ? 100 : 0);
            const isOut = visibleStock <= 0;
            const stockStatus = isOut ? 'is-out' : (pct <= 40 ? 'is-low' : 'is-ok');
            const strokeColor = isOut ? '#e5e7eb' : (pct <= 40 ? '#ef4444' : '#facc15');
            const pathLen = 216.77;
            const offset = pathLen * (1 - (isOut ? 0 : pct / 100));

            const visual = tieneFoto
                ? `<img class="product-foto ${isOut ? 'foto-agotada' : ''}" src="${fotoSrc}" alt="${escapeHtml(p.nombre)}" loading="lazy" decoding="async">`
                : `<span class="emoji ${isOut ? 'foto-agotada' : ''}">${emojiDe(p)}</span>`;

            const precioTexto = Number(p.precio_venta) % 1 === 0 ? 'BS ' + Math.round(p.precio_venta) : 'BS ' + Number(p.precio_venta).toFixed(2);

            card.innerHTML = `
                <span class="admin-stock-cat-tag">${escapeHtml(catNombre)}</span>
                <div class="gauge-wrapper" style="margin-top: 8px;">
                    <svg class="gauge-svg" viewBox="0 0 120 120" width="130" height="130" aria-hidden="true">
                        <path class="gauge-track" d="M 27.47 92.53 A 46 46 0 1 1 92.53 92.53" fill="none" stroke="#e5e7eb" stroke-width="11" stroke-linecap="round" />
                        <path class="gauge-bar" d="M 27.47 92.53 A 46 46 0 1 1 92.53 92.53" fill="none" stroke="${strokeColor}" stroke-width="11" stroke-linecap="round" stroke-dasharray="${pathLen}" stroke-dashoffset="${offset}" />
                    </svg>
                    <div class="gauge-inner">
                        <svg class="gauge-cloud-bg" viewBox="0 0 100 100" aria-hidden="true">
                            <path d="M 50 12 C 63 12, 75 18, 81 28 C 88 39, 88 52, 83 63 C 86 74, 79 84, 69 88 C 58 91, 44 90, 34 85 C 23 88, 14 79, 13 68 C 11 56, 15 45, 20 36 C 16 26, 25 15, 36 13 C 41 12, 46 12, 50 12 Z" fill="#374151" />
                        </svg>
                        ${visual}
                        <div class="stamp-agotado ${isOut ? '' : 'hide'}">AGOTADO</div>
                    </div>
                    <div class="card-price-pill price"><span class="price-val">${precioTexto}</span></div>
                </div>
                <div class="card-lower-zone">
                    <svg class="card-mid-wave" viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden="true">
                        <path d="M 0 20 L 0 10 C 60 2, 130 16, 200 8 L 200 20 Z" fill="#f1f5f9" />
                    </svg>
                    <div class="card-mid-body">
                        <h3 class="product-card-title">${escapeHtml(p.nombre)}</h3>
                        <div class="admin-stock-qty-pill ${stockStatus}">
                            <span class="stock-qty-label">Stock:</span>
                            <span class="stock-qty-num">${visibleStock}</span>
                            <span class="stock-qty-unit">${isOut ? 'agotado' : 'uds.'}</span>
                        </div>
                    </div>
                </div>
                <div class="admin-stock-actions-grid">
                    <button type="button" class="stock-action-btn entrada" data-id="${p.id_producto}" title="Ingresar stock">
                        <span>＋</span> Entrada
                    </button>
                    <button type="button" class="stock-action-btn salida" data-id="${p.id_producto}" title="Registrar salida o merma">
                        <span>−</span> Salida
                    </button>
                    <button type="button" class="stock-action-btn historial" data-id="${p.id_producto}" title="Ver historial de movimientos">
                        <span>🕒</span> Historial
                    </button>
                </div>
            `;

            card.querySelector('.stock-action-btn.entrada').addEventListener('click', () => openStockActionModal(p, 'ENTRADA'));
            card.querySelector('.stock-action-btn.salida').addEventListener('click', () => openStockActionModal(p, 'SALIDA'));
            card.querySelector('.stock-action-btn.historial').addEventListener('click', () => openStockHistoryModal(p));

            grid.appendChild(card);
        });

        renderAdminStockPagination(totalPages, totalItems);
    }

    function renderAdminStockPagination(totalPages, totalItems) {
        const pagContainer = document.getElementById('admin-stock-pagination');
        if (!pagContainer) return;

        if (totalItems === 0) {
            pagContainer.innerHTML = '<span class="comanda-pag-info">0 productos encontrados</span>';
            return;
        }

        if (totalPages <= 1) {
            pagContainer.innerHTML = `<span class="comanda-pag-info">Mostrando <strong>${totalItems}</strong> productos</span>`;
            return;
        }

        let html = `
            <button type="button" class="comanda-pag-btn btn-prev" ${adminStockPage <= 1 ? 'disabled' : ''}>
                ◀ Anterior
            </button>
        `;

        const maxBotones = 5;
        let startPage = Math.max(1, adminStockPage - Math.floor(maxBotones / 2));
        let endPage = Math.min(totalPages, startPage + maxBotones - 1);
        if (endPage - startPage + 1 < maxBotones) {
            startPage = Math.max(1, endPage - maxBotones + 1);
        }

        if (startPage > 1) {
            html += `<button type="button" class="comanda-pag-btn btn-num" data-page="1">1</button>`;
            if (startPage > 2) html += `<span class="comanda-pag-info">...</span>`;
        }

        for (let p = startPage; p <= endPage; p++) {
            html += `<button type="button" class="comanda-pag-btn btn-num ${p === adminStockPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
        }

        if (endPage < totalPages) {
            if (endPage < totalPages - 1) html += `<span class="comanda-pag-info">...</span>`;
            html += `<button type="button" class="comanda-pag-btn btn-num" data-page="${totalPages}">${totalPages}</button>`;
        }

        html += `
            <button type="button" class="comanda-pag-btn btn-next" ${adminStockPage >= totalPages ? 'disabled' : ''}>
                Siguiente ▶
            </button>
            <span class="comanda-pag-info">(${totalItems} productos · Pág. ${adminStockPage}/${totalPages})</span>
        `;

        pagContainer.innerHTML = html;

        const prev = pagContainer.querySelector('.btn-prev');
        if (prev) {
            prev.addEventListener('click', () => {
                if (adminStockPage > 1) {
                    adminStockPage--;
                    renderAdminStockGrid();
                    const grid = document.getElementById('admin-stock-cards-grid');
                    if (grid) grid.scrollTop = 0;
                }
            });
        }

        const next = pagContainer.querySelector('.btn-next');
        if (next) {
            next.addEventListener('click', () => {
                if (adminStockPage < totalPages) {
                    adminStockPage++;
                    renderAdminStockGrid();
                    const grid = document.getElementById('admin-stock-cards-grid');
                    if (grid) grid.scrollTop = 0;
                }
            });
        }

        pagContainer.querySelectorAll('.btn-num').forEach(btn => {
            btn.addEventListener('click', () => {
                const p = parseInt(btn.dataset.page, 10);
                if (p && p !== adminStockPage) {
                    adminStockPage = p;
                    renderAdminStockGrid();
                    const grid = document.getElementById('admin-stock-cards-grid');
                    if (grid) grid.scrollTop = 0;
                }
            });
        });
    }

    // Modal de acción rápida de stock (+ Entrada, - Salida, Ajuste)
    function openStockActionModal(prod, type = 'ENTRADA') {
        currentStockModalProduct = prod;
        currentStockModalType = type;

        const modal = document.getElementById('stock-action-modal');
        if (!modal) return;

        document.getElementById('sam-title').textContent = prod.nombre;
        document.getElementById('sam-current-stock').textContent = `${prod.stock_actual} uds`;
        
        const imgContainer = document.getElementById('sam-img-container');
        if (imgContainer) {
            imgContainer.innerHTML = prod.tiene_foto
                ? `<img src="${urlFoto(prod)}" style="max-height: 44px; max-width: 100%; object-fit: contain;">`
                : `<span style="font-size: 1.8rem;">${emojiDe(prod)}</span>`;
        }

        // Seleccionar tipo
        setStockModalType(type);

        // Resetear cantidad a valor razonable
        const qtyInput = document.getElementById('sam-qty-input');
        qtyInput.value = type === 'AJUSTE' ? prod.stock_actual : 10;

        updateStockModalPreview();
        modal.classList.remove('hide');
        qtyInput.focus();
    }

    function setStockModalType(type) {
        currentStockModalType = type;
        document.querySelectorAll('.stock-type-btn').forEach(btn => {
            const isTarget = btn.dataset.type === type;
            btn.classList.toggle('active', isTarget);
        });

        const label = document.getElementById('sam-qty-label');
        const reasonInput = document.getElementById('sam-reason');

        if (type === 'ENTRADA') {
            if (label) label.textContent = 'Cantidad a ingresar (sumar)';
            if (reasonInput && !reasonInput.value) reasonInput.value = 'Compra / Abastecimiento';
        } else if (type === 'SALIDA') {
            if (label) label.textContent = 'Cantidad a retirar (restar)';
            if (reasonInput && !reasonInput.value) reasonInput.value = 'Merma / Botella rota';
        } else if (type === 'AJUSTE') {
            if (label) label.textContent = 'Nuevo stock total exacto';
            if (reasonInput && !reasonInput.value) reasonInput.value = 'Conteo físico de inventario';
        }
        updateStockModalPreview();
    }

    function updateStockModalPreview() {
        if (!currentStockModalProduct) return;
        const current = Number(currentStockModalProduct.stock_actual) || 0;
        const qty = parseInt(document.getElementById('sam-qty-input').value, 10) || 0;
        let resultado = current;

        if (currentStockModalType === 'ENTRADA') resultado = current + Math.max(0, qty);
        else if (currentStockModalType === 'SALIDA') resultado = Math.max(0, current - Math.max(0, qty));
        else if (currentStockModalType === 'AJUSTE') resultado = Math.max(0, qty);

        const previewEl = document.getElementById('sam-preview-stock');
        if (previewEl) {
            const diff = resultado - current;
            const diffText = diff > 0 ? ` (+${diff})` : (diff < 0 ? ` (${diff})` : '');
            previewEl.textContent = `${resultado} uds${diffText}`;
            previewEl.style.color = resultado > 0 ? '#34d399' : '#f87171';
        }
    }

    async function submitQuickStockAction() {
        if (!currentStockModalProduct) return;

        const qty = parseInt(document.getElementById('sam-qty-input').value, 10);
        const reason = (document.getElementById('sam-reason').value || '').trim();

        if (isNaN(qty) || qty < 0) {
            notify('Introduce una cantidad válida.', 'warn');
            return;
        }
        if (currentStockModalType !== 'AJUSTE' && qty <= 0) {
            notify('La cantidad debe ser mayor que cero.', 'warn');
            return;
        }
        if (!reason) {
            notify('Ingresa el motivo del movimiento.', 'warn');
            document.getElementById('sam-reason').focus();
            return;
        }

        const btn = document.getElementById('sam-confirm-btn');
        btn.disabled = true;

        try {
            const response = await fetch('/api/admin/stock/movimiento', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id_producto: currentStockModalProduct.id_producto,
                    tipo_movimiento: currentStockModalType,
                    cantidad: qty,
                    motivo: reason,
                    id_admin: currentUser ? currentUser.id_admin : 1,
                    id_evento: currentUser ? currentUser.id_evento : 1
                })
            });

            const data = await response.json();
            if (data.success) {
                notify(`✔ Stock actualizado: ${currentStockModalProduct.nombre} ahora tiene ${data.stock_nuevo} uds.`, 'ok');
                currentStockModalProduct.stock_actual = data.stock_nuevo;
                
                // Actualizar producto en el array local
                const idx = adminStockProducts.findIndex(p => p.id_producto === currentStockModalProduct.id_producto);
                if (idx !== -1) adminStockProducts[idx].stock_actual = data.stock_nuevo;

                document.getElementById('stock-action-modal').classList.add('hide');
                renderAdminStockGrid();
            } else {
                notify(data.message || 'No se pudo registrar el movimiento.', 'error');
            }
        } catch (err) {
            console.error(err);
            notify('Sin conexión con el servidor.', 'error');
        } finally {
            btn.disabled = false;
        }
    }

    // Modal de Historial de Producto
    async function openStockHistoryModal(prod) {
        const modal = document.getElementById('stock-history-modal');
        if (!modal) return;

        document.getElementById('shm-title').textContent = `Movimientos: ${prod.nombre}`;
        document.getElementById('shm-subtitle').textContent = `Stock actual: ${prod.stock_actual} uds · Consultando registros...`;
        const tbody = document.getElementById('shm-table-body');
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 20px;">Cargando historial...</td></tr>`;

        modal.classList.remove('hide');

        try {
            const res = await fetch(`/api/admin/productos/${prod.id_producto}/movimientos`);
            const data = await res.json();
            const movs = data.movimientos || [];

            document.getElementById('shm-subtitle').textContent = `Stock actual: ${prod.stock_actual} uds · ${movs.length} movimientos registrados`;

            if (movs.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--text-secondary);">No hay movimientos registrados para este producto.</td></tr>`;
                return;
            }

            tbody.innerHTML = '';
            movs.forEach(m => {
                const tr = document.createElement('tr');
                const badgeClase = m.tipo_movimiento === 'ENTRADA' ? 'badge-entregada' : (m.tipo_movimiento === 'SALIDA' ? 'badge-anulado' : 'badge-proceso');
                const responsable = m.nombre_mesero ? `👤 ${m.nombre_mesero}` : (m.nombre_cajero ? `Cajero: ${m.nombre_cajero}` : (m.nombre_admin || 'Admin'));

                tr.innerHTML = `
                    <td><span class="badge ${badgeClase}">${escapeHtml(m.tipo_movimiento)}</span></td>
                    <td style="font-weight: 700;">${m.cantidad}</td>
                    <td style="font-size: 0.85rem;">${m.stock_anterior} $\to$ <strong style="color: #34d399;">${m.stock_nuevo}</strong></td>
                    <td style="font-size: 0.8rem; color: #c7d2fe;">${escapeHtml(responsable)}</td>
                    <td style="font-size: 0.75rem; white-space: nowrap;">${new Date(m.fecha_hora).toLocaleDateString()} ${new Date(m.fecha_hora).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
                    <td style="font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(m.motivo || '—')}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch (err) {
            console.error(err);
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #f87171;">Error al consultar el historial.</td></tr>`;
        }
    }

    // Bind listeners para el modal de stock
    document.querySelectorAll('.stock-type-btn').forEach(btn => {
        btn.addEventListener('click', () => setStockModalType(btn.dataset.type));
    });

    const qtyInput = document.getElementById('sam-qty-input');
    if (qtyInput) {
        qtyInput.addEventListener('input', updateStockModalPreview);
    }
    const minusBtn = document.getElementById('sam-minus-btn');
    if (minusBtn) {
        minusBtn.addEventListener('click', () => {
            const v = Math.max(1, (parseInt(qtyInput.value, 10) || 1) - 1);
            qtyInput.value = v;
            updateStockModalPreview();
        });
    }
    const plusBtn = document.getElementById('sam-plus-btn');
    if (plusBtn) {
        plusBtn.addEventListener('click', () => {
            const v = (parseInt(qtyInput.value, 10) || 0) + 1;
            qtyInput.value = v;
            updateStockModalPreview();
        });
    }

    document.querySelectorAll('.stock-preset-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const addVal = parseInt(chip.dataset.val, 10) || 1;
            if (currentStockModalType === 'AJUSTE') {
                qtyInput.value = addVal;
            } else {
                qtyInput.value = (parseInt(qtyInput.value, 10) || 0) + addVal;
            }
            updateStockModalPreview();
        });
    });

    const cancelSamBtn = document.getElementById('sam-cancel-btn');
    if (cancelSamBtn) {
        cancelSamBtn.addEventListener('click', () => document.getElementById('stock-action-modal').classList.add('hide'));
    }
    const confirmSamBtn = document.getElementById('sam-confirm-btn');
    if (confirmSamBtn) {
        confirmSamBtn.addEventListener('click', submitQuickStockAction);
    }

    const closeShmBtn = document.getElementById('shm-close-btn');
    if (closeShmBtn) {
        closeShmBtn.addEventListener('click', () => document.getElementById('stock-history-modal').classList.add('hide'));
    }

    // Buscador de stock
    const adminStockSearchInput = document.getElementById('admin-stock-search');
    if (adminStockSearchInput) {
        adminStockSearchInput.addEventListener('input', (e) => {
            adminStockSearchQuery = e.target.value;
            adminStockPage = 1;
            renderAdminStockGrid();
        });
    }

    // Toggle albarán collapsible
    const toggleAlbaranBtn = document.getElementById('toggle-albaran-btn');
    if (toggleAlbaranBtn) {
        toggleAlbaranBtn.addEventListener('click', () => {
            const section = document.getElementById('albaran-collapsible-section');
            if (section) {
                const isHidden = section.classList.toggle('hide');
                toggleAlbaranBtn.textContent = isHidden ? '📥 Ingreso por Albarán / Lote' : '✕ Ocultar formulario de albarán';
                if (!isHidden) section.scrollIntoView({ behavior: 'smooth' });
            }
        });
    }

    // TAB: AUDIT LOGS DATA
    async function loadAuditsData() {
        try {
            const response = await fetch('/api/admin/auditoria');
            const data = await response.json();

            // Render Stock movements
            const tbodyMovs = document.getElementById('movs-table-body');
            tbodyMovs.innerHTML = '';

            if (!data.movimientos || data.movimientos.length === 0) {
                tbodyMovs.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 24px; font-weight: 700; color: #71717a;">No hay movimientos de stock registrados</td></tr>`;
            } else {
                data.movimientos.forEach(m => {
                    const tr = document.createElement('tr');
                    const meseroHtml = m.nombre_mesero
                        ? `<span class="badge" style="background: #e0e7ff; color: #3730a3; border: 1.5px solid #000000; font-weight: 800; font-size: 0.75rem; padding: 2px 8px; border-radius: 6px; box-shadow: 1px 1px 0px #000000; white-space: nowrap;">👤 ${escapeHtml(m.nombre_mesero)}</span>`
                        : (m.nombre_cajero
                            ? `<span style="font-size: 0.76rem; font-weight: 700; color: #18181b; white-space: nowrap;">Cajero: ${escapeHtml(m.nombre_cajero)}</span>`
                            : (m.nombre_admin
                                ? `<span style="font-size: 0.76rem; font-weight: 700; color: #18181b; white-space: nowrap;">Admin: ${escapeHtml(m.nombre_admin)}</span>`
                                : '<span style="color: #a1a1aa; font-size: 0.75rem;">—</span>'));

                    let tipoBadge = '';
                    if (m.tipo_movimiento === 'ENTRADA') {
                        tipoBadge = `<span class="badge" style="background: #dcfce7; color: #15803d; border: 1.5px solid #000000; font-weight: 800; padding: 2px 8px; border-radius: 6px; box-shadow: 1px 1px 0px #000000;">ENTRADA</span>`;
                    } else if (m.tipo_movimiento === 'SALIDA') {
                        tipoBadge = `<span class="badge" style="background: #fee2e2; color: #b91c1c; border: 1.5px solid #000000; font-weight: 800; padding: 2px 8px; border-radius: 6px; box-shadow: 1px 1px 0px #000000;">SALIDA</span>`;
                    } else {
                        tipoBadge = `<span class="badge" style="background: #fef08a; color: #854d0e; border: 1.5px solid #000000; font-weight: 800; padding: 2px 8px; border-radius: 6px; box-shadow: 1px 1px 0px #000000;">${escapeHtml(m.tipo_movimiento || 'AJUSTE')}</span>`;
                    }

                    tr.innerHTML = `
                        <td><strong>${escapeHtml(m.nombre_producto)}</strong></td>
                        <td>${tipoBadge}</td>
                        <td style="font-weight: 800; font-size: 0.88rem; color: #000000;">${m.cantidad}</td>
                        <td style="color: #71717a; font-weight: 700;">${m.stock_anterior}</td>
                        <td style="font-weight: 900; color: #059669; font-size: 0.90rem;">${m.stock_nuevo}</td>
                        <td>${meseroHtml}</td>
                        <td style="font-size: 0.76rem; font-weight: 600; color: #3f3f46; white-space: nowrap;">${new Date(m.fecha_hora).toLocaleString()}</td>
                        <td style="font-size: 0.78rem; font-weight: 600; color: #52525b;">${escapeHtml(m.motivo || '-')}</td>
                    `;
                    tbodyMovs.appendChild(tr);
                });
            }

            // Render Admin Audits
            const tbodyAudits = document.getElementById('audits-table-body');
            tbodyAudits.innerHTML = '';

            if (!data.auditoria || data.auditoria.length === 0) {
                tbodyAudits.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 24px; font-weight: 700; color: #71717a;">No hay registros de auditoría registrados</td></tr>`;
            } else {
                data.auditoria.forEach(a => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td><strong>${escapeHtml(a.nombre_admin)}</strong></td>
                        <td><span class="badge" style="background: #f3e8ff; color: #6b21a8; border: 1.5px solid #000000; font-weight: 800; padding: 2px 8px; border-radius: 6px; box-shadow: 1px 1px 0px #000000;">${escapeHtml(a.accion)}</span></td>
                        <td style="font-size: 0.82rem; font-weight: 600; color: #18181b;">${escapeHtml(a.detalle)}</td>
                        <td style="font-size: 0.76rem; font-weight: 600; color: #52525b; white-space: nowrap;">${new Date(a.fecha_hora).toLocaleString()}</td>
                    `;
                    tbodyAudits.appendChild(tr);
                });
            }
        } catch (err) {
            console.error("Error loading audits:", err);
        }
    }

    // TAB: INVENTARIO / STOCK REPORT
    let inventoryPage = 1;
    const inventoryLimit = 14;
    let allInventoryProducts = [];
    let allInventoryCategoriesMap = {};
    let filteredInventoryProducts = [];

    let invFilterSearch = '';
    let invFilterCategory = 'all';
    let invFilterStatus = 'all';
    let invFilterSort = 'id_asc';
    let invFiltersInitialized = false;

    async function loadInventoryData() {
        try {
            const response = await fetch('/api/productos');
            const data = await response.json();

            allInventoryProducts = data.productos || [];
            allInventoryCategoriesMap = {};
            
            if (data.categorias) {
                data.categorias.forEach(cat => {
                    allInventoryCategoriesMap[cat.id_categoria] = cat.nombre;
                });
            }

            const catSelect = document.getElementById('inv-filter-cat');
            if (catSelect && data.categorias) {
                const currentVal = catSelect.value || 'all';
                catSelect.innerHTML = '<option value="all">Todas las categorías</option>';
                data.categorias.forEach(cat => {
                    const opt = document.createElement('option');
                    opt.value = cat.id_categoria;
                    opt.textContent = cat.nombre;
                    catSelect.appendChild(opt);
                });
                catSelect.value = currentVal;
            }

            initInventoryFilterListeners();
            applyInventoryFilters();
        } catch (err) {
            console.error("Error loading inventory:", err);
        }
    }

    function initInventoryFilterListeners() {
        if (invFiltersInitialized) return;
        invFiltersInitialized = true;

        const searchInput = document.getElementById('inv-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                invFilterSearch = e.target.value;
                inventoryPage = 1;
                applyInventoryFilters();
            });
        }

        const catSelect = document.getElementById('inv-filter-cat');
        if (catSelect) {
            catSelect.addEventListener('change', (e) => {
                invFilterCategory = e.target.value;
                inventoryPage = 1;
                applyInventoryFilters();
            });
        }

        const statusSelect = document.getElementById('inv-filter-status');
        if (statusSelect) {
            statusSelect.addEventListener('change', (e) => {
                invFilterStatus = e.target.value;
                inventoryPage = 1;
                applyInventoryFilters();
            });
        }

        const sortSelect = document.getElementById('inv-filter-sort');
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                invFilterSort = e.target.value;
                inventoryPage = 1;
                applyInventoryFilters();
            });
        }

        const clearBtn = document.getElementById('inv-clear-filters-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                invFilterSearch = '';
                invFilterCategory = 'all';
                invFilterStatus = 'all';
                invFilterSort = 'id_asc';

                if (searchInput) searchInput.value = '';
                if (catSelect) catSelect.value = 'all';
                if (statusSelect) statusSelect.value = 'all';
                if (sortSelect) sortSelect.value = 'id_asc';

                inventoryPage = 1;
                applyInventoryFilters();
            });
        }
    }

    function applyInventoryFilters() {
        const query = (invFilterSearch || '').toLowerCase().trim();

        filteredInventoryProducts = allInventoryProducts.filter(p => {
            // Buscador por nombre, ID o categoría
            const catName = (allInventoryCategoriesMap[p.id_categoria] || '').toLowerCase();
            const prodName = (p.nombre || '').toLowerCase();
            const prodId = '#' + p.id_producto;
            const matchSearch = !query || prodName.includes(query) || prodId.includes(query) || catName.includes(query);

            // Categoría
            const matchCat = (invFilterCategory === 'all') || (p.id_categoria === invFilterCategory);

            // Estado
            let matchStatus = true;
            if (invFilterStatus === 'out') {
                matchStatus = (p.stock_actual <= 0);
            } else if (invFilterStatus === 'low') {
                matchStatus = (p.stock_actual > 0 && p.stock_actual <= 15);
            } else if (invFilterStatus === 'ok') {
                matchStatus = (p.stock_actual > 0);
            }

            return matchSearch && matchCat && matchStatus;
        });

        // Ordenamiento
        filteredInventoryProducts.sort((a, b) => {
            if (invFilterSort === 'id_desc') return b.id_producto - a.id_producto;
            if (invFilterSort === 'nombre_asc') return (a.nombre || '').localeCompare(b.nombre || '');
            if (invFilterSort === 'stock_asc') return a.stock_actual - b.stock_actual;
            if (invFilterSort === 'stock_desc') return b.stock_actual - a.stock_actual;
            return a.id_producto - b.id_producto; // default id_asc
        });

        const summaryCount = document.getElementById('inv-summary-count');
        if (summaryCount) {
            summaryCount.innerHTML = `<strong>${allInventoryProducts.length}</strong> productos en total · Mostrando <strong>${filteredInventoryProducts.length}</strong> con filtros aplicados`;
        }

        renderInventoryPage();
    }

    function formatFechaRegistro(fechaStr) {
        if (!fechaStr) return '<span style="color: #9ca3af;">—</span>';
        try {
            const parts = fechaStr.split(' ');
            const dateParts = parts[0].split('-');
            if (dateParts.length === 3) {
                const timePart = parts[1] ? parts[1].slice(0, 5) : '';
                return `<span style="font-size: 0.82rem; color: #374151; font-weight: 600;">${dateParts[2]}/${dateParts[1]}/${dateParts[0]}</span> <small style="color: #6b7280; font-size: 0.74rem;">${timePart}</small>`;
            }
            return escapeHtml(fechaStr);
        } catch {
            return escapeHtml(fechaStr);
        }
    }

    function renderInventoryPage() {
        const tbody = document.getElementById('inventory-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        const totalItems = filteredInventoryProducts.length;

        if (totalItems === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 28px; color: #71717a; font-weight: 600;">No se encontraron productos con los filtros aplicados.</td></tr>';
            renderInventoryPagination(0, 0);
            return;
        }

        const totalPages = Math.ceil(totalItems / inventoryLimit) || 1;
        if (inventoryPage > totalPages) inventoryPage = totalPages;
        if (inventoryPage < 1) inventoryPage = 1;

        const start = (inventoryPage - 1) * inventoryLimit;
        const end = start + inventoryLimit;
        const pageProducts = filteredInventoryProducts.slice(start, end);

        pageProducts.forEach(p => {
            const catName = allInventoryCategoriesMap[p.id_categoria] || 'General';
            let stockBadge = '';
            if (p.stock_actual <= 0) {
                stockBadge = `<span class="badge-stock agotado">0 ⚠️ (Agotado)</span>`;
            } else if (p.stock_actual <= 15) {
                stockBadge = `<span class="badge-stock bajo">${p.stock_actual} ⚠️ (Bajo)</span>`;
            } else {
                stockBadge = `<span class="badge-stock normal">${p.stock_actual} uds.</span>`;
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>#${p.id_producto}</strong></td>
                <td>${escapeHtml(catName)}</td>
                <td style="font-weight: 700; color: #000000;">${escapeHtml(p.nombre)}</td>
                <td>${stockBadge}</td>
            `;
            tbody.appendChild(tr);
        });

        renderInventoryPagination(totalPages, totalItems);
    }

    function renderInventoryPagination(totalPages, totalItems) {
        const pagContainer = document.getElementById('inventory-pagination');
        if (!pagContainer) return;

        if (totalItems === 0) {
            pagContainer.innerHTML = '<span class="comanda-pag-info">0 productos encontrados</span>';
            return;
        }

        if (totalPages <= 1) {
            pagContainer.innerHTML = `<span class="comanda-pag-info">Mostrando los <strong>${totalItems}</strong> productos</span>`;
            return;
        }

        let html = `
            <button type="button" class="comanda-pag-btn btn-prev" ${inventoryPage <= 1 ? 'disabled' : ''}>
                ◀ Anterior
            </button>
        `;

        const maxBotones = 5;
        let startPage = Math.max(1, inventoryPage - Math.floor(maxBotones / 2));
        let endPage = Math.min(totalPages, startPage + maxBotones - 1);
        if (endPage - startPage + 1 < maxBotones) {
            startPage = Math.max(1, endPage - maxBotones + 1);
        }

        if (startPage > 1) {
            html += `<button type="button" class="comanda-pag-btn btn-num" data-page="1">1</button>`;
            if (startPage > 2) html += `<span class="comanda-pag-info">...</span>`;
        }

        for (let p = startPage; p <= endPage; p++) {
            html += `<button type="button" class="comanda-pag-btn btn-num ${p === inventoryPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
        }

        if (endPage < totalPages) {
            if (endPage < totalPages - 1) html += `<span class="comanda-pag-info">...</span>`;
            html += `<button type="button" class="comanda-pag-btn btn-num" data-page="${totalPages}">${totalPages}</button>`;
        }

        html += `
            <button type="button" class="comanda-pag-btn btn-next" ${inventoryPage >= totalPages ? 'disabled' : ''}>
                Siguiente ▶
            </button>
            <span class="comanda-pag-info">(${totalItems} productos · Pág. ${inventoryPage}/${totalPages})</span>
        `;

        pagContainer.innerHTML = html;

        const prev = pagContainer.querySelector('.btn-prev');
        if (prev) {
            prev.addEventListener('click', () => {
                if (inventoryPage > 1) {
                    inventoryPage--;
                    renderInventoryPage();
                    const container = document.querySelector('#tab-inventario .table-container');
                    if (container) container.scrollTop = 0;
                }
            });
        }

        const next = pagContainer.querySelector('.btn-next');
        if (next) {
            next.addEventListener('click', () => {
                if (inventoryPage < totalPages) {
                    inventoryPage++;
                    renderInventoryPage();
                    const container = document.querySelector('#tab-inventario .table-container');
                    if (container) container.scrollTop = 0;
                }
            });
        }

        pagContainer.querySelectorAll('.btn-num').forEach(btn => {
            btn.addEventListener('click', () => {
                const p = parseInt(btn.dataset.page, 10);
                if (p && p !== inventoryPage) {
                    inventoryPage = p;
                    renderInventoryPage();
                    const container = document.querySelector('#tab-inventario .table-container');
                    if (container) container.scrollTop = 0;
                }
            });
        });
    }

    // Reporte de inventario en papel térmico, con el mismo maquetado en columnas
    // fijas que los tickets de venta (ver rawbt.js).
    function buildInventoryOps(settings) {
        const H = ThermalPrinter.helpers;
        const w = settings.width;
        const ops = [];

        const prods = (filteredInventoryProducts && filteredInventoryProducts.length > 0) ? filteredInventoryProducts : allInventoryProducts;

        ops.push(H.op('*** MASTERDRINKS ***', { align: 'center', bold: true, tall: true, isLogo: true }));
        ops.push(H.op('REPORTE DE INVENTARIO', { align: 'center', bold: true }));
        ops.push(H.op(new Date().toLocaleString(), { align: 'center' }));
        ops.push(H.op(H.divider(w)));

        // Agrupado por categoría: en 32 columnas se lee mucho mejor que una
        // tabla de cuatro columnas apretadas.
        const porCategoria = new Map();
        prods.forEach(p => {
            const cat = allInventoryCategoriesMap[p.id_categoria] || 'General';
            if (!porCategoria.has(cat)) porCategoria.set(cat, []);
            porCategoria.get(cat).push(p);
        });

        let bajos = 0;
        [...porCategoria.keys()].sort().forEach(cat => {
            ops.push(H.op(cat.toUpperCase(), { bold: true }));
            porCategoria.get(cat).forEach(p => {
                const isLow = p.stock_actual <= 15;
                if (isLow) bajos++;
                H.twoCol('#' + p.id_producto + ' ' + p.nombre, p.stock_actual + (isLow ? ' *' : ''), w)
                    .forEach(l => ops.push(H.op(l)));
            });
            ops.push(H.op(H.divider(w)));
        });

        ops.push(H.op('Productos listados: ' + prods.length + ' de ' + allInventoryProducts.length));
        ops.push(H.op('Con stock bajo (<= 15): ' + bajos));
        ops.push(H.op(''));
        ops.push(H.op('* Indica stock bajo', { align: 'center' }));
        ops.push(H.op('Reporte oficial de operacion', { align: 'center' }));

        return ops;
    }

    document.getElementById('print-inventory-btn').addEventListener('click', () => {
        if (allInventoryProducts.length === 0) return;
        const settings = ThermalPrinter.getSettings();
        const H = ThermalPrinter.helpers;
        H.sendBytes(H.opsToEscPos(buildInventoryOps(settings), settings), settings);
    });

    document.getElementById('print-inventory-browser-btn').addEventListener('click', () => {
        if (allInventoryProducts.length === 0) return;
        const settings = ThermalPrinter.getSettings();
        const H = ThermalPrinter.helpers;
        const maxMm = settings.width >= 48 ? '78mm' : '58mm';

        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            notify('El navegador bloqueó la ventana de impresión. Permite las ventanas emergentes.', 'error');
            return;
        }

        printWindow.document.write(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Inventario POS</title><style>' +
            '@page { size: auto; margin: 0mm; }' +
            '* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }' +
            'html, body { margin: 0; padding: 0; background: #fff; color: #000; width: 100%; }' +
            'body { display: flex; flex-direction: column; align-items: center; justify-content: flex-start;' +
            ' font-family: "Courier New", Courier, "Lucida Console", monospace; font-size: 13.5px; font-weight: 600; line-height: 1.28; }' +
            '.inventory-ticket { width: 100%; max-width: ' + maxMm + '; margin: 0 auto; padding: 4mm 2mm 8mm 2mm; }' +
            '.inventory-ticket div { white-space: pre-wrap; word-break: break-word; font-family: inherit; }' +
            '@media print {' +
            '  body { width: 100%; margin: 0; padding: 0; display: block; }' +
            '  .inventory-ticket { margin: 0 auto; width: 100%; max-width: ' + maxMm + '; padding: 2mm 1mm 6mm 1mm; }' +
            '}' +
            '</style></head><body>' +
            '<div class="inventory-ticket">' +
            H.opsToHtml(buildInventoryOps(settings), settings) +
            '</div>' +
            '<script>window.onload=function(){window.print();setTimeout(function(){window.close();},300);};<\/script>' +
            '</body></html>'
        );
        printWindow.document.close();
    });

    // Nombres de producto, motivos de anulación y observaciones los escribe
    // el personal y se insertan con innerHTML: hay que neutralizarlos antes.
    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

// ==========================================
    // PROMOCIONES (panel de administración)
    // ==========================================
    // Un paquete de productos a precio cerrado. Se arma aquí eligiendo qué
    // lleva y cuánto cuesta; el resto lo hace el servidor.

    let promosAdmin = [];
    // Lo que se está armando ahora: id_producto -> cantidad. Un Map y no una
    // lista para que añadir dos veces la misma cerveza sume, en vez de dejar
    // dos renglones iguales.
    let promoArmando = new Map();
    // Si se está editando una que ya existe, su id. null si es nueva.
    let promoEditando = null;

    function precioSueltoArmado() {
        let suma = 0;
        promoArmando.forEach((cant, id) => {
            const p = (catalogoAdmin.productos || []).find(x => x.id_producto === id);
            if (p) suma += Number(p.precio_venta) * cant;
        });
        return Math.round(suma * 100) / 100;
    }

    function pintarSelectorProductos() {
        const sel = document.getElementById('promo-producto');
        if (!sel) return;
        const elegido = sel.value;
        sel.innerHTML = '';

        const vacio = document.createElement('option');
        vacio.value = '';
        vacio.textContent = 'Elige un producto…';
        sel.appendChild(vacio);

        // Agrupados por categoría, igual que la lista del catálogo: con veinte
        // productos, una lista plana obliga a leerla entera.
        const porCat = new Map();
        (catalogoAdmin.productos || []).filter(p => p.activo).forEach(p => {
            const cat = (catalogoAdmin.categorias || [])
                .find(c => c.id_categoria === p.id_categoria);
            const nombre = cat ? cat.nombre : 'Sin categoría';
            if (!porCat.has(nombre)) porCat.set(nombre, []);
            porCat.get(nombre).push(p);
        });

        [...porCat.keys()].sort().forEach(nombreCat => {
            const grupo = document.createElement('optgroup');
            grupo.label = nombreCat;
            porCat.get(nombreCat).forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id_producto;
                opt.textContent = p.nombre + '  ·  ' + Number(p.precio_venta).toFixed(2) + ' Bs.';
                grupo.appendChild(opt);
            });
            sel.appendChild(grupo);
        });

        if (elegido) sel.value = elegido;
    }

    function pintarContenidoArmado() {
        const caja = document.getElementById('promo-contenido');
        const cuentas = document.getElementById('promo-cuentas');
        if (!caja) return;
        caja.innerHTML = '';

        if (promoArmando.size === 0) {
            const vacio = document.createElement('p');
            vacio.className = 'promo-vacio';
            vacio.textContent = 'Todavía no lleva nada. Elige un producto y añádelo.';
            caja.appendChild(vacio);
        }

        promoArmando.forEach((cant, id) => {
            const p = (catalogoAdmin.productos || []).find(x => x.id_producto === id);
            const fila = document.createElement('div');
            fila.className = 'promo-linea';

            const texto = document.createElement('span');
            texto.className = 'promo-linea-nombre';
            texto.textContent = p ? p.nombre : 'producto #' + id;
            fila.appendChild(texto);

            const precio = document.createElement('span');
            precio.className = 'promo-linea-precio';
            precio.textContent = p
                ? (Number(p.precio_venta) * cant).toFixed(2) + ' Bs.'
                : '';
            fila.appendChild(precio);

            const control = document.createElement('div');
            control.className = 'promo-linea-control';

            const menos = document.createElement('button');
            menos.type = 'button';
            menos.className = 'cart-qty-btn';
            menos.textContent = '−';
            menos.setAttribute('aria-label', 'Una menos de ' + (p ? p.nombre : ''));
            menos.addEventListener('click', () => {
                const ahora = promoArmando.get(id) || 0;
                if (ahora <= 1) promoArmando.delete(id);
                else promoArmando.set(id, ahora - 1);
                pintarContenidoArmado();
            });
            control.appendChild(menos);

            const num = document.createElement('span');
            num.className = 'promo-linea-cant';
            num.textContent = cant;
            control.appendChild(num);

            const mas = document.createElement('button');
            mas.type = 'button';
            mas.className = 'cart-qty-btn';
            mas.textContent = '+';
            mas.setAttribute('aria-label', 'Uno más de ' + (p ? p.nombre : ''));
            mas.addEventListener('click', () => {
                promoArmando.set(id, Math.min(99, (promoArmando.get(id) || 0) + 1));
                pintarContenidoArmado();
            });
            control.appendChild(mas);

            const quitar = document.createElement('button');
            quitar.type = 'button';
            quitar.className = 'lista-borrar';
            quitar.textContent = '✕';
            quitar.title = 'Quitar de la promoción';
            quitar.setAttribute('aria-label', 'Quitar ' + (p ? p.nombre : '') + ' de la promoción');
            quitar.addEventListener('click', () => {
                promoArmando.delete(id);
                pintarContenidoArmado();
            });
            control.appendChild(quitar);

            fila.appendChild(control);
            caja.appendChild(fila);
        });

        // La cuenta a la vista mientras se teclea el precio: es lo que evita
        // dar de alta un "combo" que sale más caro que comprarlo suelto.
        if (cuentas) {
            const suelto = precioSueltoArmado();
            const pedido = Number(document.getElementById('promo-precio').value);
            if (!suelto) {
                cuentas.textContent = '';
                cuentas.className = 'promo-cuentas';
            } else if (!Number.isFinite(pedido) || pedido <= 0) {
                cuentas.textContent = 'Suelto costaría ' + suelto.toFixed(2) + ' Bs.';
                cuentas.className = 'promo-cuentas';
            } else {
                const ahorro = Math.round((suelto - pedido) * 100) / 100;
                cuentas.textContent = ahorro > 0
                    ? 'Suelto costaría ' + suelto.toFixed(2) + '. El cliente ahorra ' + ahorro.toFixed(2) + ' Bs.'
                    : ahorro === 0
                        ? 'Cuesta lo mismo que suelto. No es una promoción.'
                        : 'Cuidado: sale ' + Math.abs(ahorro).toFixed(2) + ' Bs. MÁS CARO que comprarlo suelto.';
                cuentas.className = 'promo-cuentas' + (ahorro > 0 ? ' bien' : ' mal');
            }
        }
    }

    // ---- Foto en el formulario de promociones -------------------------------
    let fotoNuevaPromo = null;

    const promoFotoInput = document.getElementById('promo-foto');
    const promoFotoVista = document.getElementById('promo-foto-vista');
    const promoFotoQuitar = document.getElementById('promo-foto-quitar');

    if (promoFotoInput) {
        promoFotoInput.addEventListener('change', async e => {
            const archivo = e.target.files && e.target.files[0];
            if (!archivo) return;
            try {
                fotoNuevaPromo = await reducirImagen(archivo);
                pintarFoto(promoFotoVista, fotoNuevaPromo);
                if (promoFotoQuitar) promoFotoQuitar.classList.remove('hide');
            } catch (err) {
                notify(err.message || 'No se pudo usar esa imagen.', 'error');
                promoFotoInput.value = '';
            }
        });

        if (promoFotoQuitar) {
            promoFotoQuitar.addEventListener('click', () => {
                fotoNuevaPromo = '';
                promoFotoInput.value = '';
                pintarFoto(promoFotoVista, null);
                promoFotoQuitar.classList.add('hide');
            });
        }
    }

    function limpiarFotoPromoForm() {
        fotoNuevaPromo = null;
        if (promoFotoInput) promoFotoInput.value = '';
        pintarFoto(promoFotoVista, null);
        if (promoFotoQuitar) promoFotoQuitar.classList.add('hide');
    }

    // Cambiar la foto de una promoción desde la lista
    const fotoPromoSuelta = document.createElement('input');
    fotoPromoSuelta.type = 'file';
    fotoPromoSuelta.accept = 'image/png,image/jpeg,image/webp';
    fotoPromoSuelta.className = 'foto-input';
    document.body.appendChild(fotoPromoSuelta);
    let promoDeLaFoto = null;

    fotoPromoSuelta.addEventListener('change', async e => {
        const archivo = e.target.files && e.target.files[0];
        if (!archivo || !promoDeLaFoto) return;
        try {
            const dataUri = await reducirImagen(archivo);
            await guardarFotoPromo(promoDeLaFoto, dataUri);
        } catch (err) {
            notify(err.message || 'No se pudo usar esa imagen.', 'error');
        } finally {
            fotoPromoSuelta.value = '';
            promoDeLaFoto = null;
        }
    });

    function pedirFotoParaPromo(id_promocion) {
        promoDeLaFoto = id_promocion;
        fotoPromoSuelta.click();
    }

    async function guardarFotoPromo(id_promocion, dataUri) {
        try {
            const res = await fetch('/api/admin/promociones/' + id_promocion + '/foto', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ foto: dataUri })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo guardar la foto.', 'error');
                return;
            }
            notify(data.message, 'ok');
            cargarPromociones();
            fetchProductsAndMenu();
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    }

    function limpiarFormularioPromo() {
        promoEditando = null;
        promoArmando = new Map();
        limpiarFotoPromoForm();
        document.getElementById('promo-nombre').value = '';
        document.getElementById('promo-desc').value = '';
        document.getElementById('promo-precio').value = '';
        document.getElementById('promo-titulo-form').textContent = 'Nueva promoción';
        document.getElementById('promo-guardar').textContent = 'Crear promoción';
        document.getElementById('promo-cancelar').classList.add('hide');
        pintarContenidoArmado();
    }

    function editarPromocion(pr) {
        promoEditando = pr.id_promocion;
        promoArmando = new Map((pr.contenido || []).map(c => [c.id_producto, c.cantidad]));
        document.getElementById('promo-nombre').value = pr.nombre || '';
        document.getElementById('promo-desc').value = pr.descripcion || '';
        document.getElementById('promo-precio').value = Number(pr.precio).toFixed(2);
        document.getElementById('promo-titulo-form').textContent = 'Editar promoción';
        document.getElementById('promo-guardar').textContent = 'Guardar cambios';
        document.getElementById('promo-cancelar').classList.remove('hide');

        if (pr.tiene_foto) {
            fotoNuevaPromo = urlFotoPromo(pr);
            pintarFoto(promoFotoVista, fotoNuevaPromo);
            if (promoFotoQuitar) promoFotoQuitar.classList.remove('hide');
        } else {
            limpiarFotoPromoForm();
        }

        pintarContenidoArmado();
        const adminMain = document.querySelector('#admin-view .admin-main');
        if (adminMain) {
            adminMain.scrollTo({ top: 0, behavior: 'smooth' });
        }
        const promoInput = document.getElementById('promo-nombre');
        if (promoInput) {
            promoInput.focus({ preventScroll: true });
        }
    }

    async function cargarPromociones() {
        try {
            const res = await fetch('/api/admin/promociones');
            const data = await res.json();
            promosAdmin = data.promociones || [];
            pintarPromociones();
        } catch (err) {
            notify('No se pudieron cargar las promociones.', 'error');
        }
    }

    function pintarPromociones() {
        const lista = document.getElementById('lista-promociones');
        const cuenta = document.getElementById('cont-promociones');
        if (!lista) return;
        lista.innerHTML = '';
        if (cuenta) cuenta.textContent = promosAdmin.length;

        if (promosAdmin.length === 0) {
            lista.innerHTML = '<p class="promo-vacio">Todavía no hay ninguna promoción.</p>';
            return;
        }

        promosAdmin.forEach(pr => {
            const dentro = (pr.contenido || [])
                .map(c => c.cantidad + ' × ' + c.nombre).join('  +  ');
            const estaActiva = Boolean(pr.activa);
            const fila = filaLista({
                titulo: pr.nombre,
                detalle: Number(pr.precio).toFixed(2) + ' Bs.',
                insignia: pr.ahorro > 0 ? 'ahorra ' + Number(pr.ahorro).toFixed(2) : null,
                nota: dentro,
                inactivo: false, // Una promoción apagada NO es "retirada": se puede volver a encender en cualquier momento
                foto: urlFotoPromo(pr),
                onFoto: () => pedirFotoParaPromo(pr.id_promocion),
                onEditar: () => editarPromocion(pr),
                marcas: [{
                    texto: estaActiva ? 'Encendida' : 'Apagada',
                    activa: estaActiva,
                    onTocar: () => alternarPromocion(pr)
                }],
                onBorrar: () => borrarPromocion(pr)
            });
            if (!estaActiva) {
                fila.classList.add('promo-apagada');
            }
            lista.appendChild(fila);
        });
    }

    async function guardarPromocion() {
        const boton = document.getElementById('promo-guardar');
        const cuerpo = {
            nombre: document.getElementById('promo-nombre').value,
            descripcion: document.getElementById('promo-desc').value,
            precio: document.getElementById('promo-precio').value,
            contenido: [...promoArmando.entries()]
                .map(([id_producto, cantidad]) => ({ id_producto, cantidad })),
            id_admin: currentUser ? currentUser.id_admin : 1
        };
        if (fotoNuevaPromo !== null) {
            cuerpo.foto = fotoNuevaPromo;
        }

        boton.disabled = true;
        try {
            const ruta = promoEditando
                ? '/api/admin/promociones/' + promoEditando
                : '/api/admin/promociones';
            const res = await fetch(ruta, {
                method: promoEditando ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cuerpo)
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo guardar.', 'error', 6000);
                return;
            }
            notify(data.message, 'ok');
            limpiarFormularioPromo();
            cargarPromociones();
            // La caja tiene que ver el combo nuevo sin recargar.
            fetchProductsAndMenu();
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        } finally {
            boton.disabled = false;
        }
    }

    async function alternarPromocion(pr) {
        try {
            const nuevaActiva = pr.activa ? 0 : 1;
            const res = await fetch('/api/admin/promociones/' + pr.id_promocion, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nombre: pr.nombre,
                    descripcion: pr.descripcion,
                    precio: pr.precio,
                    activa: nuevaActiva,
                    id_admin: currentUser ? currentUser.id_admin : 1
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo cambiar el estado.', 'error');
                return;
            }
            notify(nuevaActiva ? `"${pr.nombre}" encendida.` : `"${pr.nombre}" apagada.`, 'ok');
            cargarPromociones();
            fetchProductsAndMenu();
        } catch (err) {
            notify('Sin conexión con el servidor.', 'error');
        }
    }

    async function borrarPromocion(pr) {
        const si = await pedirConfirmacion({
            titulo: '¿Eliminar promoción?',
            mensaje: `¿Deseas eliminar la promoción "${pr.nombre}"?`,
            detalle: 'Los productos que lleva dentro no se tocan.',
            textoAceptar: 'Eliminar',
            textoCancelar: 'Cancelar',
            tipo: 'peligro',
            icono: '🗑️'
        });
        if (!si) return;
        try {
            const res = await fetch('/api/admin/promociones/' + pr.id_promocion, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_admin: currentUser ? currentUser.id_admin : 1 })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo eliminar.', 'error');
                return;
            }
            notify(data.message, 'ok');
            if (promoEditando === pr.id_promocion) limpiarFormularioPromo();
            cargarPromociones();
            fetchProductsAndMenu();
        } catch (err) {
            notify('Sin conexión con el servidor.', 'error');
        }
    }

    document.getElementById('promo-anadir').addEventListener('click', () => {
        const sel = document.getElementById('promo-producto');
        const id = parseInt(sel.value, 10);
        const cant = parseInt(document.getElementById('promo-cantidad').value, 10);
        if (!id) {
            notify('Elige primero un producto.', 'warn');
            return;
        }
        if (!Number.isInteger(cant) || cant <= 0) {
            notify('La cantidad tiene que ser 1 o más.', 'warn');
            return;
        }
        promoArmando.set(id, Math.min(99, (promoArmando.get(id) || 0) + cant));
        sel.value = '';
        document.getElementById('promo-cantidad').value = 1;
        pintarContenidoArmado();
    });

    document.getElementById('promo-precio').addEventListener('input', pintarContenidoArmado);
    document.getElementById('promo-guardar').addEventListener('click', guardarPromocion);
    document.getElementById('promo-cancelar').addEventListener('click', limpiarFormularioPromo);

    // Utility: helper to show errors inside containers
    function showError(element, text) {
        element.textContent = text;
        element.classList.remove('hide');
    }

    // ==========================================
    // MODO PANTALLA COMPLETA PERSISTENTE (TABLETS)
    // ==========================================
    function asegurarPantallaCompleta() {
        if (localStorage.getItem('pwa_fullscreen') === '1') {
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                const docEl = document.documentElement;
                if (docEl.requestFullscreen) docEl.requestFullscreen().catch(() => {});
                else if (docEl.webkitRequestFullscreen) docEl.webkitRequestFullscreen();
            }
        }
    }

    const btnFullscreen = document.getElementById('btn-toggle-fullscreen');
    function actualizarBotonFullscreen() {
        if (!btnFullscreen) return;
        const textEl = btnFullscreen.querySelector('.fs-text');
        const iconEl = btnFullscreen.querySelector('.fs-icon');
        const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (textEl) textEl.textContent = isFs ? 'Salir de Pantalla Completa' : 'Pantalla Completa';
        if (iconEl) iconEl.textContent = isFs ? '✕' : '⛶';
    }

    if (btnFullscreen) {
        btnFullscreen.addEventListener('click', () => {
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                localStorage.setItem('pwa_fullscreen', '1');
                const docEl = document.documentElement;
                if (docEl.requestFullscreen) docEl.requestFullscreen().catch(() => {});
                else if (docEl.webkitRequestFullscreen) docEl.webkitRequestFullscreen();
            } else {
                localStorage.setItem('pwa_fullscreen', '0');
                if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            }
        });

        document.addEventListener('fullscreenchange', actualizarBotonFullscreen);
        document.addEventListener('webkitfullscreenchange', actualizarBotonFullscreen);
        actualizarBotonFullscreen();
    }

    const adminFsBtn = document.getElementById('admin-fullscreen-btn');
    if (adminFsBtn) {
        adminFsBtn.addEventListener('click', () => {
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                localStorage.setItem('pwa_fullscreen', '1');
                const docEl = document.documentElement;
                if (docEl.requestFullscreen) docEl.requestFullscreen().catch(() => {});
                else if (docEl.webkitRequestFullscreen) docEl.webkitRequestFullscreen();
            } else {
                localStorage.setItem('pwa_fullscreen', '0');
                if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            }
        });
    }

    // Auto-activar o restaurar pantalla completa en interacciones clave
    ['waiter-lock-modal', 'pos-view', 'admin-view'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('pointerdown', asegurarPantallaCompleta, { passive: true });
            el.addEventListener('click', asegurarPantallaCompleta, { passive: true });
        }
    });

    // Safeguard: Ensure the outer browser window or portal containers never get shifted/scrolled out of view
    function resetPortalScrolls() {
        if (window.scrollY !== 0 || window.scrollX !== 0) {
            window.scrollTo(0, 0);
        }
        ['login-view', 'pos-view', 'admin-view', 'waiter-lock-modal'].forEach(id => {
            const el = document.getElementById(id);
            if (el && (el.scrollTop !== 0 || el.scrollLeft !== 0)) {
                el.scrollTop = 0;
                el.scrollLeft = 0;
            }
        });
    }

    window.addEventListener('scroll', resetPortalScrolls, { passive: true });
    ['login-view', 'pos-view', 'admin-view', 'waiter-lock-modal'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('scroll', resetPortalScrolls, { passive: true });
    });

    // Recalcular tamaño de botones de categorías al cambiar tamaño de pantalla o rotar tablet
    window.addEventListener('resize', () => {
        resetPortalScrolls();
        recalcularBotonesCategorias();
    });
    window.addEventListener('orientationchange', () => {
        resetPortalScrolls();
        setTimeout(recalcularBotonesCategorias, 100);
    });
    if (typeof window !== 'undefined' && window.ResizeObserver) {
        const catListElem = document.getElementById('category-list');
        if (catListElem) {
            new ResizeObserver(() => {
                recalcularBotonesCategorias();
            }).observe(catListElem);
        }
    }
});
