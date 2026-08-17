# Montar los servidores de barra

Cada barra lleva **su propio servidor**: su tablet, su base de datos, su stock,
sus cajeros y su numeración de comandas. No se hablan entre ellas. Al final de
la noche cada una da su propio cierre en PDF.

Este documento es para el montaje. Hazlo **el día antes**, no el mismo día.

---

## Qué necesitas por barra

- **1 tablet servidor** — la que corre el programa y comparte el WiFi.
  Enchufada a la corriente toda la noche.
- **0 o más tablets cliente** — las que cobran. Se conectan por el WiFi de la
  tablet servidor y abren la página en el navegador.
- La tablet servidor **también puede cobrar**: abre `http://localhost:3000`.

No hace falta internet en ningún momento. El hotspot solo crea una red local
entre las tablets; no necesita datos móviles ni contratar nada.

---

## 1. Preparar la tablet servidor (una vez por barra)

### 1.1 Instalar Termux

Descarga Termux **desde F-Droid**, no desde Play Store: la versión de Play Store
está abandonada y falla al instalar Node.

    https://f-droid.org/packages/com.termux/

### 1.2 Instalar Node

Abre Termux y escribe:

    pkg update && pkg upgrade
    pkg install nodejs

Comprueba la versión:

    node -v

**Tiene que ser 22.5 o superior.** El programa usa la base de datos que trae
Node incorporada; con una versión anterior no arranca. Si sale menor, repite
`pkg upgrade nodejs`.

### 1.3 Dar acceso al almacenamiento

    termux-setup-storage

Acepta el permiso que sale en pantalla. Esto te deja copiar la carpeta del
proyecto desde el almacenamiento de la tablet.

---

## 2. Copiar el programa

Pasa la carpeta `masterdrinks` a la tablet (por cable USB, por Drive, como
prefieras) y déjala en Descargas. Luego, en Termux:

    cp -r ~/storage/shared/Download/masterdrinks ~/
    cd ~/masterdrinks
    npm install --omit=dev

El `--omit=dev` salta las librerías que solo sirven para las pruebas: son 69
paquetes, unos 4 MB. Con ellas serían muchos más y no aportan nada en la barra.

---

## 3. Darle nombre a la barra

Esto es lo único distinto en cada tablet. Crea el archivo de configuración:

    nano .env

Y escribe **solo estas tres líneas**, cambiando el nombre según la barra:

**Tablet de la Barra Norte:**

    INSTANCIA=Norte
    PREFIJO=N
    PORT=3000

**Tablet de la Barra Sur:**

    INSTANCIA=Sur
    PREFIJO=S
    PORT=3000

**Tablet de la Barra General:**

    INSTANCIA=General
    PREFIJO=G
    PORT=3000

Guarda con `Ctrl+O`, Enter, y sal con `Ctrl+X`.

El puerto es 3000 en las tres: como son tablets distintas, no se estorban.

**Para qué sirve el prefijo:** las comandas de Norte salen `N-1, N-2, N-3...` y
las de Sur `S-1, S-2, S-3...`. Sin esto habría tres comandas «#1» circulando la
misma noche y, al juntar las bases al final, no se sabría cuál es cuál. El
nombre queda además grabado dentro del propio archivo de la base, así que cada
base se identifica sola aunque la copies a otro equipo meses después.

---

## 4. Encender el WiFi de la barra

En los ajustes de Android de la **tablet servidor**, activa el punto de acceso
(hotspot). Ponle un nombre que distinga la barra, por ejemplo `BARRA-NORTE`, y
una contraseña.

No necesita datos móviles: solo tiene que crear la red.

---

## 5. Arrancar

En Termux, dentro de `~/masterdrinks`:

    termux-wake-lock
    node server.js

El `termux-wake-lock` es importante: sin él Android duerme el proceso cuando se
apaga la pantalla y las tablets cliente pierden la conexión a mitad de venta.

Verás algo así:

    ==================================================
       B A R R A :   NORTE
       Comandas de esta barra: N-1, N-2, ...
    ==================================================
    🚀 MasterDrinks POS iniciado
       En esta misma tablet:  http://localhost:3000

       👉 En las OTRAS tablets de la barra Norte:
          http://192.168.43.1:3000

       Ctrl+C para detener.
    ==================================================

**Lee la primera línea.** Es la confirmación de que esta tablet es la que crees
que es. Si dice `PRINCIPAL`, es que el `.env` no se guardó bien: párala y
revísalo antes de seguir.

**Apunta la dirección.** Es la que teclean las demás tablets de esa barra.

La primera vez creará la base de datos sola, con los 20 productos, los 9
cajeros y los 45 meseros. Verás `Seeding SQLite database...`. Las siguientes
veces dirá `Seeding skipped`, que es lo normal: significa que ya tiene datos y
no los toca.

---

## 6. Conectar las tablets cliente

En cada tablet que vaya a cobrar en esa barra:

1. Conéctala al WiFi de **esa** barra (`BARRA-NORTE`, etc.).
2. Abre Chrome y escribe la dirección que salió arriba: `http://192.168.43.1:3000`
3. Menú de Chrome → **Añadir a pantalla de inicio**, para abrirla de un toque.
   El acceso directo se llamará `MasterDrinks · Norte`, con el nombre de su
   barra, así que en la pantalla de inicio ya se distinguen.

En la pantalla de acceso verás una **etiqueta ámbar con el nombre de la barra**.
Compruébala siempre antes de cobrar: es lo que te dice si esa tablet está
conectada al servidor correcto. Sale también arriba en la caja y en el panel de
administrador, y cada ticket impreso lleva el prefijo (`COMANDA N-47`).

---

## 6b. Etiquetar las tablets por fuera

El programa te dice en qué barra estás **una vez encendido**. Pero durante el
montaje vas a tener varias tablets apagadas encima de una mesa, y ahí no hay
software que valga.

Pon una etiqueta con cinta en la parte de atrás de cada una:

    NORTE · SERVIDOR          NORTE · CAJA 2
    (no apagar)               cajero_norte_2

Con el nombre de la barra, si es la servidora, y qué usuario de cajero le toca.
Cuesta cinco minutos y evita el error más caro del montaje: encender el servidor
de Sur creyendo que es el de Norte y cargarle el stock equivocado.

Resumen de por dónde saber qué barra es cada cosa:

| Dónde miras | Qué te dice |
|---|---|
| Etiqueta pegada en la tablet | Antes de encenderla |
| Primera línea en Termux | `B A R R A : NORTE` al arrancar el servidor |
| Etiqueta ámbar en pantalla | En login, caja y panel de administrador |
| Nombre del WiFi | `BARRA-NORTE` en las tablets cliente |
| Acceso directo | `MasterDrinks · Norte` |
| Ticket impreso | `COMANDA N-47` |
| Nombre del PDF de cierre | `Cierre_Norte_...pdf` |
| El propio archivo `.db` | Lleva grabado su nombre de barra dentro |

---

## 7. Cargar el stock real de esa barra

Cada barra arranca con el stock de ejemplo, que es el mismo en las tres. Hay que
poner el real **en cada una**.

Entra como administrador (`admin_evento` / `demo123`), pestaña **📦 Ajustar
Stock**, y por cada producto:

- Producto: el que sea
- Tipo de movimiento: **Ajuste (Reemplazar Stock total)**
- Cantidad: las unidades reales que hay **en esa barra**
- Motivo: `Carga inicial`

> Esto es hoy lo más pesado del montaje: 20 productos por barra, uno a uno.
> Está pendiente una pantalla de carga en bloque para hacerlo de un tirón.

**Ojo:** el stock es independiente por barra. Si pones 120 en las tres, las tres
creerán tener 120 y entre todas venderás 360.

---

## 8. Repartir los cajeros

Cada barra tiene sus tres cajeros ya creados:

| Barra   | Usuarios                                              |
|---------|-------------------------------------------------------|
| Norte   | `cajero_norte_1`, `cajero_norte_2`, `cajero_norte_3`   |
| Sur     | `cajero_sur_1`, `cajero_sur_2`, `cajero_sur_3`         |
| General | `cajero_general_1`, `cajero_general_2`, `cajero_general_3` |

Contraseña de todos: `demo123` — **cámbiala antes del evento.**

Usa **un usuario distinto por tablet** dentro de la misma barra. Así el cierre
te dice cuánto cobró cada puesto, y si al contar el efectivo falta dinero sabes
en qué caja mirar.

Los PIN de mesero (1001–1045) funcionan en **cualquier tablet de esa barra**.

---

## 9. Al terminar la noche

En **cada** tablet servidor, por este orden:

1. Panel de administrador → Dashboard → **⬇️ Descargar PDF**.
   Sale `Cierre_Norte_...pdf`, con el nombre de su barra.
2. En Termux, `Ctrl+C` para parar el servidor.
   Esto es lo que vuelca los datos pendientes al archivo de la base.
3. Copia el archivo `pos_evento.db` a sitio seguro:

       cp ~/masterdrinks/pos_evento.db ~/storage/shared/Download/barra_norte.db

**Nunca copies `pos_evento.db` con el servidor encendido**, y nunca borres los
archivos que terminan en `-wal` o `-shm`: ahí pueden estar las últimas ventas
todavía sin volcar. Parar con `Ctrl+C` primero deja el `.db` completo y solo.

Guardando los tres archivos (`barra_norte.db`, `barra_sur.db`,
`barra_general.db`) se podrán juntar después para sacar el total del evento.

---

## Repaso antes de abrir puertas

- [ ] `node -v` da 22.5 o más en las tres tablets servidor
- [ ] Cada `.env` tiene **su** `INSTANCIA` y `PREFIJO` (no los copies iguales)
- [ ] Al arrancar, cada servidor rotula **su** barra y ninguno dice `PRINCIPAL`
- [ ] Todas las tablets etiquetadas por fuera con su barra y su cajero
- [ ] Cada tablet servidor está enchufada a la corriente
- [ ] `termux-wake-lock` ejecutado antes de arrancar
- [ ] Batería sin restricciones para Termux
      (Ajustes → Aplicaciones → Termux → Batería → Sin restricciones)
- [ ] Hotspot encendido, con nombre distinto por barra
- [ ] Cada tablet cliente abre la página y **muestra la etiqueta de su barra**
- [ ] Stock real cargado en cada barra
- [ ] Contraseñas cambiadas
- [ ] Una venta de prueba completa en cada barra, con ticket impreso
- [ ] Las ventas de prueba anuladas antes de empezar de verdad

---

## Si algo va mal

**Una tablet cliente no abre la página.** Comprueba que está en el WiFi de esa
barra y no en otro. Si el WiFi es el correcto, vuelve a mirar la dirección que
imprimió el servidor: puede haber cambiado al reconectar el hotspot.

**El servidor se paró solo.** Android lo durmió. Vuelve a `~/masterdrinks`,
ejecuta `termux-wake-lock` y `node server.js`. Las ventas ya guardadas están a
salvo. Quita las restricciones de batería a Termux para que no vuelva a pasar.

**Un PIN de mesero no funciona.** Ese mesero no existe en **esa** base. Cada
barra tiene su propia copia: si diste de alta un mesero nuevo, lo diste de alta
solo en una.

**Dice que no hay stock y sí lo hay.** El stock de esa base no es el real.
Ajústalo desde el panel; ver el punto 7.

**Aparece la etiqueta de otra barra.** La tablet se conectó al hotspot
equivocado. Cámbiala de red antes de cobrar nada.
