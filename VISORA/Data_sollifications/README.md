# Earth Jukebox · versión oficial

Sonificación de imágenes de la Tierra tocada con las manos (Kinect) o con el mouse.

```
earth-jukebox/
├── index.html        estructura de la página
├── css/style.css     estilos
└── js/
    ├── data.js       imágenes, acordes, temas, utilidades y estado compartido
    ├── audio.js      motor musical (Tone.js): limitador, presupuesto de voces, textura órgano/reloj
    ├── effects.js    efectos visuales procedurales (WebGL) + HUD
    ├── hands.js      manos del Kinect (SSE /events) y mouse de respaldo
    ├── preview.js    ventana con lo que ve el Kinect y las manos que está tomando
    └── main.js       une todo: carga de imágenes, píxeles bajo cada mano, notas, carrusel
```

## Imágenes

Usa las 6 imágenes de `recursos/space` (`stock1.png` … `stock6.png`). Las sirve `auralis_visuals.py`, porque abierto con doble clic el navegador no deja leer los píxeles de archivos locales. Si el programa no corre, cada imagen muestra un aviso y se carga sola en cuanto arranca.

- **Color dinámico:** el color de acento (HUD, bordes, puntos, curvas, botones, ventana de la cámara) se saca de cada imagen. Es el tono dominante más el segundo tono más presente, y cambia suavemente al pasar de imagen.
- **Cambiar música o nombres:** en `js/data.js` cada imagen tiene su título, instrumento, modo, tempo y acordes.

## Tema de órgano

En ciertos momentos suena una frase de órgano original: cuando la textura llega al máximo 3 compases seguidos, o tras unos 50 s tocando. Nunca suena más de una vez cada 35 s y el HUD muestra `♪ TEMA`.

## Cómo correrlo con el Kinect

1. En la carpeta `kinect`, corre `py auralis_visuals.py` (como siempre). Al arrancar dice
   `Earth Jukebox: puente listo en el puerto 8765`.
2. Abre `earth-jukebox/index.html` con **doble clic**. Se conecta sola: no hay que escribir ninguna dirección.
   Si abres la página primero, se conecta en cuanto arranca el programa.
3. Para que el sonido arranque sin clic en la instalación, abre Chrome con
   `--autoplay-policy=no-user-gesture-required`. Si no, aparece un aviso y basta un clic o una tecla.

Mientras el programa no corre, la página funciona con el mouse.

Si el audio cruje en una computadora lenta, abre la página con `index.html?latency=playback` (más margen, algo más de retraso).
`py auralis_visuals.py --no-web` lo corre sin el puente.

| Gesto | Qué hace |
|---|---|
| Levantar una mano 1.2 s en la portada | Entrar |
| Mano levantada y en movimiento | Toca notas (izquierda una octava abajo, derecha la melodía) |
| Mano visible pero abajo | Se ve tenue, no suena |
| Moverse rápido y sostenido | Crece la textura de órgano y reloj |
| Aplauso | Siguiente imagen |

Controla una sola persona: la más cercana al sensor (se fija hasta perderla 0.7 s). Una mano cuenta como **levantada** cuando está más arriba que el torso (articulación `Spine`).

### Parámetros de URL

| Parámetro | Efecto |
|---|---|
| `?mouse` | Solo mouse, sin Kinect |
| `?events=http://host:puerto/events` | Otra dirección del flujo (por defecto, la de `auralis_visuals.py`) |
| `?mirror` | Invierte izquierda/derecha |
| `?margin=0.1` | Margen de la región segura |
| `?play=vis` | Toca con cualquier mano visible, aunque no esté levantada |

## Ver qué está tomando el Kinect

Arriba a la izquierda aparece una ventana con lo que ve el sensor de profundidad: gris por distancia, silueta en azul y esqueleto. Funciona a oscuras porque no usa la cámara RGB. Encima se dibujan las manos de la persona que controla:

- **Círculo relleno + "TOCANDO"**: la mano está levantada y es cursor (suena).
- **Aro + "ABAJO"**: la mano se ve pero no toca.
- **Aro punteado + "PERDIDA"**: el tracker la perdió.
- **X roja + "FUERA"**: está fuera de la región segura (el rectángulo punteado).

Abajo dice qué persona controla, a qué distancia está y cuántas manos están tocando. La tecla **C** la oculta o la muestra, y se arrastra desde su barra. Si el video viene de otra dirección, usa `?cam=URL`.

## Teclas

| Tecla | Qué hace |
|---|---|
| ← → | Cambiar de imagen (o pasa el mouse sobre la imagen para ver las flechas) |
| C | Mostrar u ocultar la ventana de la cámara del Kinect |
| I | Datos técnicos: nota, acorde, voces sonando… |
| V (en la ventana de Python) | Volver a ver los visuales de Python mientras la página está conectada |

## Audio: notas técnicas

- Los instrumentos son voces nativas ligeras. Cuando se llena la polifonía se apaga la nota más vieja; nunca se tira la nueva.
- Hay un solo contexto de audio, con buffer grande (`playback`). Las notas de las manos no esperan al reloj musical.
- Hay un solo limitador, con su ganancia automática compensada. Debajo del umbral la cadena deja el sonido igual.
- Mientras la página está conectada, `auralis_visuals.py` pausa sus visuales para dejarle CPU al audio.
- Si notas retraso entre la mano y el sonido, prueba `index.html?latency=balanced`.

## Sin Kinect

Abre `index.html` con doble clic y usa el mouse. Las flechas del teclado cambian de imagen.
