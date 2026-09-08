# Montar la barra

Una tablet hace de **servidor**: corre el programa, guarda la base de datos y
comparte el WiFi. Las demás tablets se conectan a ella y cobran. Al terminar la
noche, esa tablet saca el cierre en PDF.

Este documento es para el montaje. Hazlo **el día antes**, no el mismo día.

---

## Qué necesitas

- **1 tablet servidor** — la que corre el programa y comparte el WiFi.
  Enchufada a la corriente toda la noche.
- **0 o más tablets cliente** — las que cobran. Se conectan por el WiFi de la
  tablet servidor y abren la página en el navegador.
- La tablet servidor **también puede cobrar**: abre `http://localhost:3000`.

No hace falta internet en ningún momento. El hotspot solo crea una red local
entre las tablets; no necesita datos móviles ni contratar nada.

---

## 1. Preparar la tablet servidor

### 1.1 Instalar Termux

Descarga Termux **desde F-Droid**, no desde Play Store: la versión de Play Store
está abandonada y falla al instalar Node.

### 1.2 Instalar Node

En Termux:

    pkg update
    pkg install nodejs-lts

Comprueba que quedó bien:

    node -v

Tiene que decir **22.5 o más**. El programa usa el SQLite que trae Node por
dentro; con una versión anterior no arranca.

### 1.3 Dar acceso al almacenamiento

    termux-setup-storage

Acepta el permiso que sale en pantalla. Sin esto Termux no ve la carpeta de
Descargas y no podrás copiar el programa ni sacar las copias de seguridad.

---

## 2. Copiar el programa

Pasa la carpeta `masterdrinks` a la tablet (por cable USB, por Drive, como
prefieras) y déjala en Descargas. Luego, en Termux:

    cp -r ~/storage/shared/Download/masterdrinks ~/
    cd ~/masterdrinks
    npm install --omit=dev

También sirve clonar el repositorio, que lleva la base con el montaje dentro:

    git clone https://github.com/adri5616/masterdrinks.git ~/masterdrinks
    cd ~/masterdrinks
    npm install --omit=dev

> **No hagas `git pull` con el evento en marcha.** La base de datos está
> versionada, y git no sabe fusionar un archivo binario: solo reemplazarlo. Un
> pull para traer un arreglo de código puede llevarse las ventas de la noche.
> Si no queda más remedio, copia `pos_evento.db` fuera de la carpeta antes del
> pull y devuélvela después.

El `--omit=dev` salta las librerías que solo sirven para las pruebas: son 69
paquetes, unos 4 MB. Con ellas serían muchos más y no aportan nada en la barra.

> **Ojo con la carpeta.** `npm install` tiene que ejecutarse **dentro** de
> `~/masterdrinks`. Si lo lanzas desde otro sitio dará
> `npm error code ENOENT ... package.json`, que solo significa que ahí no está
> el programa.

---

## 3. Encender el WiFi

En los ajustes de Android de la **tablet servidor**, activa el punto de acceso
(hotspot). Ponle nombre y contraseña.

No necesita datos móviles: solo tiene que crear la red.

---

## 4. Arrancar

En Termux, dentro de `~/masterdrinks`:

    termux-wake-lock
    node server.js

El `termux-wake-lock` es importante: sin él Android duerme el proceso cuando se
apaga la pantalla y las tablets cliente pierden la conexión a mitad de venta.

Verás algo así:

    ==================================================
       B A R R A :   BARRA 1
       Comandas de esta barra: B1-1, B1-2, ...
    ==================================================
    MasterDrinks POS iniciado
       En esta misma tablet:  http://localhost:3000

       En las OTRAS tablets de la barra Barra 1:
          http://192.168.43.1:3000

       Nombre de la barra: Dashboard -> Datos del evento -> Barra.

       Ctrl+C para detener.
    ==================================================

**Apunta la dirección.** Es la que teclean las demás tablets.

La primera vez creará la base de datos sola, con los 20 productos, los 9
cajeros y los 45 meseros. Verás `Sembrando la base`. Las siguientes veces dirá
`Seeding skipped`, que es lo normal: significa que ya tiene datos y no los toca.

**Si dice que el puerto 3000 está ocupado**, el programa ya está encendido en
otra ventana. Abre `http://localhost:3000` para comprobarlo; si quieres
reiniciarlo, cierra la otra ventana con `Ctrl+C`.

---

## 5. Poner los datos del evento

Entra como administrador (`admin` / `123`) y ve a **Dashboard ->
Datos del evento**. Rellena:

| Campo | Dónde sale |
|---|---|
| **Evento** | Cabecera de los tickets y del PDF de cierre |
| **Fecha** | Cabecera del PDF y nombre del archivo |
| **Lugar** | Cabecera del PDF |
| **Barra** | Ticket, panel, prefijo de las comandas y nombre del PDF |
| **Responsable** | Firma el cierre de caja |

Dale a **Guardar datos**. El cambio se aplica al momento, sin reiniciar nada.

**La barra empieza llamándose «Barra 1».** Ponle el nombre que uses en ese
evento. De ahí sale el prefijo de las comandas: `Barra 1` da `B1-47`,
`Camerinos` da `C-47`. Ese prefijo hace que un ticket siga identificándose solo
si aparece suelto días después.

---

## 6. Conectar las tablets cliente

En cada tablet que vaya a cobrar:

1. Conéctala al WiFi de la tablet servidor.
2. Abre Chrome y escribe la dirección que salió arriba: `http://192.168.43.1:3000`
3. Menú de Chrome -> **Añadir a pantalla de inicio**, para abrirla de un toque.

En la pantalla de acceso verás una **etiqueta ámbar con el nombre de la barra**.
Si aparece, esa tablet está hablando con el servidor correcto.

---

## 7. Cargar el stock real

La base arranca con el stock de ejemplo. Hay que poner el real.

Entra como administrador, pestaña **Ajustar Stock**, y por cada producto:

- Producto: el que sea
- Tipo de movimiento: **Ajuste (Reemplazar Stock total)**
- Cantidad: las unidades reales que hay
- Motivo: `Carga inicial`

> Esto es hoy lo más pesado del montaje: 20 productos, uno a uno. Está
> pendiente una pantalla de carga en bloque para hacerlo de un tirón.

---

## 8. Repartir los cajeros

Vienen nueve cajeros ya creados. Contraseña de todos: `demo123` —
**cámbiala antes del evento.**

Usa **un usuario distinto por tablet**. Así el cierre te dice cuánto cobró cada
puesto, y si al contar el efectivo falta dinero sabes en qué caja mirar.

Puedes dar de alta los tuyos en **Personal -> Nuevo Cajero**. La barra
no se elige: es la de este servidor.

Los PIN de mesero (1001-1045) funcionan en **cualquier tablet**.

---

## 9. Al terminar la noche

Por este orden:

1. Panel de administrador -> Dashboard -> **Descargar PDF**.
   Sale `Cierre_<barra>_<fecha>.pdf`.
2. En Termux, `Ctrl+C` para parar el servidor.
   Esto es lo que vuelca los datos pendientes al archivo de la base.
3. Copia el archivo `pos_evento.db` a sitio seguro:

       cp ~/masterdrinks/pos_evento.db ~/storage/shared/Download/cierre.db

**Nunca copies `pos_evento.db` con el servidor encendido**, y nunca borres los
archivos que terminan en `-wal` o `-shm`: ahí pueden estar las últimas ventas
todavía sin volcar. Parar con `Ctrl+C` primero deja el `.db` completo y solo.

---

## Borrar las ventas de prueba

Después del ensayo, para empezar la noche desde cero:

    npm run reiniciar            enseña qué se borraría, sin tocar nada
    npm run reiniciar -- --si    lo borra de verdad

Quita las comandas, sus pagos y sus tickets, y **devuelve al stock** lo que esas
ventas se llevaron. No toca el catálogo, ni el personal, ni los datos del
evento. La primera venta real vuelve a ser la comanda #1.

Antes de borrar deja una copia en `pos_evento.antes-de-reiniciar.db`, y al
terminar comprueba que no queden pagos ni tickets sueltos y que cada producto
cuadre con su último movimiento.

**Para el ensayo, esto es mejor que anular las ventas una a una:** una comanda
anulada sigue apareciendo en el cierre como anulada, y no quieres abrir el
evento con un informe que ya trae historia.

Es un comando y no un botón del panel a propósito: durante el evento no puede
existir la forma de borrar la caja de un toque. Párale el servidor con `Ctrl+C`
antes de ejecutarlo.

---

## Repaso antes de abrir puertas

- [ ] `node -v` da 22.5 o más
- [ ] El servidor arranca y rotula la barra con el nombre correcto
- [ ] Datos del evento rellenados (evento, fecha, lugar, barra, responsable)
- [ ] La tablet servidor está enchufada a la corriente
- [ ] `termux-wake-lock` ejecutado antes de arrancar
- [ ] Batería sin restricciones para Termux
      (Ajustes -> Aplicaciones -> Termux -> Batería -> Sin restricciones)
- [ ] Hotspot encendido
- [ ] Cada tablet cliente abre la página y **muestra la etiqueta de la barra**
- [ ] Stock real cargado
- [ ] Contraseñas cambiadas
- [ ] Una venta de prueba completa, con ticket impreso
- [ ] `npm run reiniciar -- --si` para dejar la caja en cero

---

## Si algo va mal

**Una tablet cliente no abre la página.** Comprueba que está en el WiFi de la
tablet servidor y no en otro. Si el WiFi es el correcto, vuelve a mirar la
dirección que imprimió el servidor: puede haber cambiado al reconectar el
hotspot.

**El servidor se paró solo.** Android lo durmió. Vuelve a `~/masterdrinks`,
ejecuta `termux-wake-lock` y `node server.js`. Las ventas ya guardadas están a
salvo. Quita las restricciones de batería a Termux para que no vuelva a pasar.

**Dice que el puerto está ocupado.** El programa ya está encendido en otra
ventana. Mira `http://localhost:3000` antes de arrancar otro.

**Dice que no hay stock y sí lo hay.** El stock de la base no es el real.
Ajústalo desde el panel; ver el punto 7.

**`npm install` da `ENOENT ... package.json`.** No estás dentro de la carpeta
del programa. Haz `cd ~/masterdrinks` y repite.
