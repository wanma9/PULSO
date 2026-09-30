# PULSO

Demo local de telemetria urbana para comparar consultas de series temporales entre PostgreSQL estandar y PostgreSQL con TimescaleDB. El frontend consulta las dos APIs y muestra sus datos en el mismo dashboard.

## Estado y procedencia de los datos

Al cargar el dashboard, el navegador solicita `/api/overview` y `/api/queries/performance` a las dos APIs. Las APIs ejecutan consultas SQL sobre sus respectivas bases; las mediciones de rendimiento se cronometran en el backend. La serie principal del dashboard sigue generandose con el simulador local de `src/lib/simulation.ts`; el mini-panel del backend contrario usa los promedios de `/api/overview` como referencia visual. Por tanto, la lectura de las APIs y la medicion SQL son reales, pero el grafico principal aun no representa la serie historica devuelta por `/api/series`.

## Arquitectura

```text
Navegador (Vite / TanStack Start, puerto 5173)
  +-- API PostgreSQL estandar (puerto 4001) -- PostgreSQL (puerto 5433)
  +-- API TimescaleDB (puerto 4002) --------- TimescaleDB (puerto 5434)
```

Cada API ejecuta el mismo simulador al arrancar. Genera lecturas para 500 sensores y cinco metricas, con una tanda cada 250 ms (aproximadamente 10 000 filas/s en cada base). En TimescaleDB, `sensor_readings` se convierte en hypertable; en PostgreSQL estandar se usan tablas e indices normales. Los datos son sinteticos y se conservan en volumenes Docker.

## Requisitos

- Git
- Node.js 22 LTS y npm
- Docker Desktop con Docker Compose v2

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

4. Abre la URL que muestre Vite, normalmente [http://localhost:5173](http://localhost:5173). El frontend espera que las dos APIs esten en `localhost:4001` y `localhost:4002`.

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
| Frontend | `http://localhost:5173` | Dashboard web |
| API PostgreSQL | `http://localhost:4001` | Datos y consultas de la base estandar |
| API TimescaleDB | `http://localhost:4002` | Datos y consultas de TimescaleDB |
| PostgreSQL | `localhost:5433` | Conexion directa a la base estandar |
| TimescaleDB | `localhost:5434` | Conexion directa a TimescaleDB |

En ambas APIs estan disponibles `GET /health`, `GET /api/config`, `GET /api/overview`, `GET /api/series`, `GET /api/alerts` y `GET /api/queries/performance`. Por ejemplo:

```text
http://localhost:4001/api/series?metric=temperature&window=10m
http://localhost:4002/api/queries/performance
```

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

El Compose incluido es un entorno de demostracion local, no una configuracion lista para produccion. El frontend tiene las direcciones `http://localhost:4001` y `http://localhost:4002` definidas en el cliente; antes de publicarlo hay que sustituirlas por las direcciones HTTPS de las APIs. Tambien hay que restringir `CORS_ORIGIN` al origen real del frontend, cambiar las credenciales de ejemplo, proteger los puertos de base de datos y definir copias de seguridad y persistencia apropiadas.

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
