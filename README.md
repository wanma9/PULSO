# PULSO

Demo local de telemetria urbana para comparar consultas de series temporales entre PostgreSQL estandar y PostgreSQL con TimescaleDB. El frontend consulta las dos APIs y muestra sus datos en el mismo dashboard.

## Estado y procedencia de los datos

Al cargar el dashboard, el navegador solicita `/api/overview` y `/api/queries/performance` a las dos APIs. Las APIs ejecutan consultas SQL sobre sus respectivas bases; las mediciones de rendimiento se cronometran en el backend. La serie principal del dashboard sigue generandose con el simulador local de `src/lib/simulation.ts`; el mini-panel del backend contrario usa los promedios de `/api/overview` como referencia visual. Por tanto, la lectura de las APIs y la medicion SQL son reales, pero el grafico principal aun no representa la serie historica devuelta por `/api/series`.

## Arquitectura

```text
Navegador (Vite / TanStack Start, puerto 8080)
  +-- API PostgreSQL estandar (puerto 4001) -- PostgreSQL (puerto 5433)
  +-- API TimescaleDB (puerto 4002) --------- TimescaleDB (puerto 5434)
```

La API de PostgreSQL ejecuta un unico simulador y escribe cada lote identico en ambas bases, evitando dos generadores independientes. Genera una lectura completa por sensor cada 250 ms: 500 sensores, cinco medidas numericas por lectura y aproximadamente 2 000 filas/s en cada base. Temperatura, humedad, CPU, memoria y red comparten timestamp en una sola fila; el consumo se calcula a partir de la carga de CPU y la duracion del muestreo. En TimescaleDB, `sensor_readings` es una hypertable con chunks de 10 minutos; PostgreSQL estandar usa una tabla normal. Los endpoints comparativos solo cuentan filas de `shared-simulator`, y sus limites temporales se alinean al minuto para que ambos motores comparen exactamente las mismas filas.

El generador compartido elimina cada 15 minutos las lecturas antiguas y conserva por defecto la ultima hora, suficiente para las consultas del dashboard. Puedes cambiar el periodo con `DATA_RETENTION_HOURS` en el entorno de Docker Compose. La comparacion mide consultas de series temporales con ventanas de hasta 1 hora. Los resultados dependen del hardware y de la carga; no se garantiza que TimescaleDB gane en todas las consultas. La limpieza borra filas/chunks de la base, no elimina los volumenes Docker.

## Requisitos

- Git
- Node.js 22 LTS y npm
- Docker Desktop con Docker Compose v2

## Instalar Docker en Windows

Abre PowerShell como administrador. Si WSL 2 no está instalado, instala WSL y reinicia Windows cuando lo solicite:

```powershell
wsl --install
```

Después del reinicio, comprueba que WSL está disponible:

```powershell
wsl --update
wsl --status
```

Instala Docker Desktop con WinGet:

```powershell
winget install --id Docker.DockerDesktop -e --accept-source-agreements --accept-package-agreements
```

Abre Docker Desktop desde el menú Inicio y espera a que indique que el motor está en ejecución. En Settings, habilita **Use the WSL 2 based engine** si todavía no está habilitado. Verifica la instalación desde PowerShell:

```powershell
docker --version
docker compose version
docker info
```

Si WinGet no está disponible, instala Docker Desktop desde [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/). La virtualización de hardware debe estar habilitada; en equipos administrados puede requerirse autorización de IT.

## Arranque desde cero

1. Clona el repositorio y entra en la carpeta:

   ```sh
   git clone <URL_DEL_REPOSITORIO>
   cd pulso
   ```

2. Comprueba que Docker Desktop esta iniciado y levanta las dos bases de datos y las APIs:

   ```sh
   docker compose up -d --build
   ```

   La primera ejecucion descarga imagenes y compila la API; puede tardar unos minutos. Compose crea las tablas, crea la hypertable en TimescaleDB y arranca los simuladores cuando las APIs consiguen conectarse a sus bases.

3. Instala las dependencias del frontend e inicia Vite:

   ```sh
   npm install
   npm run dev
   ```

4. Abre la URL que muestre Vite, normalmente [http://localhost:8080](http://localhost:8080). El frontend espera que las dos APIs esten en `localhost:4001` y `localhost:4002`.

No hace falta instalar por separado las dependencias de `backend` al usar Docker Compose: la imagen de la API las instala durante la compilacion.

## Comprobar que esta funcionando

Comprueba el estado de los contenedores:

```sh
docker compose ps
```

Comprueba que cada API responde y esta conectada a la base correcta:

```sh
curl http://localhost:4001/health
curl http://localhost:4002/health
```

Las respuestas deben incluir `"status":"ok"`; la primera debe indicar modo `plain` y la segunda `timescale`. En PowerShell se pueden comprobar con:

```powershell
Invoke-RestMethod http://localhost:4001/health
Invoke-RestMethod http://localhost:4002/health
```

El primer lote se inserta al iniciar cada API. Si una base acaba de arrancar, espera unos segundos y recarga el dashboard para que haya datos recientes.

## Puertos y endpoints

| Servicio | URL local | Proposito |
| --- | --- | --- |
| Frontend | `http://localhost:8080` | Dashboard web |
| API PostgreSQL | `http://localhost:4001` | Datos y consultas de la base estandar |
| API TimescaleDB | `http://localhost:4002` | Datos y consultas de TimescaleDB |
| PostgreSQL | `localhost:5433` | Conexion directa a la base estandar |
| TimescaleDB | `localhost:5434` | Conexion directa a TimescaleDB |

En ambas APIs estan disponibles `GET /health`, `GET /api/config`, `GET /api/overview`, `GET /api/series`, `GET /api/alerts` y `GET /api/queries/performance`. Por ejemplo:

```text
http://localhost:4001/api/series?metric=temperature&window=10m
http://localhost:4002/api/queries/performance
```

Las consultas de rendimiento comparan la misma carga y granularidad en ambas bases: temperatura por barrio en bloques de 1 segundo, picos de CPU/red por sensor y minuto, y consumo electrico por barrio en bloques de 2 segundos. Cada consulta devuelve alrededor de 10 000 filas por su ventana temporal. TimescaleDB calcula las ventanas historicas desde continuous aggregates y combina el ultimo minuto directamente desde la hypertable; PostgreSQL agrega la ventana completa desde su tabla normal con `date_bin`. La hypertable poda chunks por tiempo y refresca las vistas continuas cada minuto. El endpoint mide el calentamiento y dos ejecuciones por consulta, devolviendo solo el recuento de filas para evitar transferir resultados innecesarios a Node. Las lecturas nuevas almacenan todas las medidas en la misma fila y el consumo en kWh, en lugar de repetir una fila por metrica.

## Operacion habitual

Ver logs de todos los servicios o de uno concreto:

```sh
docker compose logs -f
docker compose logs -f api-timescale
```

Parar contenedores conservando las bases de datos:

```sh
docker compose down
```

Volver a arrancarlos:

```sh
docker compose up -d
```

Eliminar tambien los datos persistidos y empezar con bases vacias (**esta accion borra los volumenes de ambas bases**):

```sh
docker compose down -v
docker compose up -d --build
```

Los scripts SQL de `backend/sql` se ejecutan automaticamente por la imagen de PostgreSQL solo cuando inicializa un volumen vacio. La API tambien verifica/crea el esquema al arrancar.

## Desarrollo y compilacion

Frontend:

```sh
npm run build
npm run lint
```

Backend (si se ejecuta o compila fuera de Docker):

```sh
cd backend
npm install
npm run build
```

Para ejecutar una API localmente sin Docker, primero proporciona una instancia compatible de PostgreSQL/TimescaleDB, copia `.env.example` a `.env` y configura `DB_MODE`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `PORT` y `CORS_ORIGIN`. El frontend sigue necesitando ambas APIs para la comparacion.

## Despliegue fuera de la maquina local

El Compose incluido es un entorno de demostracion local, no una configuracion lista para produccion. Antes de compilar el frontend, configura estas variables de entorno con las URLs HTTPS publicas de las APIs:

```text
VITE_API_POSTGRES_URL=https://api-postgres.ejemplo.com
VITE_API_TIMESCALE_URL=https://api-timescale.ejemplo.com
```

En plataformas que admiten variables de entorno de compilacion, define ambas en la configuracion del proyecto. Si compilas localmente, crea un archivo `.env.production` en la raiz con esos valores y ejecuta `npm run build`. Las variables se incorporan al frontend durante la compilacion; cambiar solo las variables del servidor despues de compilar no actualiza las URLs.

En cada backend configura `CORS_ORIGIN` con el origen publico exacto del frontend, por ejemplo `https://pulso.ejemplo.com` (sin ruta final); puedes separar varios origenes con comas. Si ejecutas las APIs con Docker Compose, puedes definir `FRONTEND_ORIGIN` en el entorno o en un archivo `.env` de la raiz; su valor predeterminado permite `http://localhost:5173` y `http://localhost:8080` para desarrollo. Usa HTTPS para frontend y APIs, cambia las credenciales de ejemplo, protege los puertos de base de datos y define copias de seguridad y persistencia apropiadas.

El frontend se construye con `npm run build`, pero el destino de produccion depende del adaptador de TanStack Start/Nitro configurado en `vite.config.ts`. El backend produce JavaScript ejecutable con `npm run build` en `backend`. No se incluye aqui una plataforma concreta (por ejemplo, Azure, Cloudflare o un servidor propio); para desplegar alli hay que configurar el adaptador y la infraestructura correspondiente.

## Estructura relevante

- `src/routes/index.tsx`: dashboard y lecturas del frontend hacia ambas APIs.
- `src/components/charts.tsx`: componentes SVG de graficas.
- `backend/src/index.ts`: API Express y endpoints.
- `backend/src/db.ts`: conexion y creacion/verificacion del esquema.
- `backend/src/simulator.ts`: generador de trafico de demostracion.
- `backend/sql/init-plain.sql`: esquema inicial de PostgreSQL.
- `backend/sql/init-timescale.sql`: extension e hypertable de TimescaleDB.
- `backend/README.md`: notas adicionales de la API.
- `docker-compose.yml`: topologia local de bases y APIs.
