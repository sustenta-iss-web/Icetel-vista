/**
 * Icetel Visualización - Backend Google Apps Script
 *
 * Lee las hojas de la planilla:
 * 1) "temp-humedad" (Clima)
 * 2) "UPS" (Energía)
 * 3) "CHILLER" (Chillers CH01 y CH02)
 * 4) "Cap-Frigorifica" y "KwF-KwTI" (Para cálculos de circuitos, capacidad nominal y carga TI)
 * 5) "Observacion-Operacion" (Novedades)
 *
 * === CAMBIOS DE ESTA VERSIÓN (STAND BY) ===
 * 1) NUEVO STAND BY: se agrega el estado STAND BY (equipo apagado a propósito,
 *    pero disponible) como estado independiente de OK/NOK, tanto a nivel de
 *    circuito como de equipo.
 * 2) NUEVO STAND BY: normalizarEstadoCircuito() reconoce variantes de
 *    escritura ("STAND BY", "STANDBY", "Stand By", "stand by", "standby")
 *    y las canoniza a 'STANDBY'. OK/NOK siguen normalizándose igual que antes.
 * 3) NUEVO STAND BY: calcularValEquipo() decide el aporte (val) de cada
 *    equipo según sus 2 circuitos, incluyendo las combinaciones mixtas con
 *    STAND BY. Cuando el equipo completo está en STAND BY, val = null y el
 *    equipo se EXCLUYE de la suma de "equipos funcionando" (no resta ni suma).
 * 4) NUEVO STAND BY: EQUIPOS_NECESARIOS_POR_SALA reemplaza la fórmula vieja
 *    (suma/count de TODOS los equipos existentes) por
 *    "equipos funcionando" / "equipos necesarios configurados". Si una sala
 *    no está configurada, se usa como respaldo el total de equipos físicos
 *    (= comportamiento anterior, sin STAND BY) para no romper nada.
 *
 * === CAMBIOS DE VERSIONES ANTERIORES (sin modificar en esta pasada) ===
 * - FIX MODAL KWF: leerCapacidadFrigorifica() guarda detalle por equipo
 *   (circuito 1, circuito 2, val) y doGet() lo adjunta a cada sala como
 *   `detalleKwf`.
 * - CACHE + LOCK en doGet().
 * - INVALIDACIÓN INSTANTÁNEA vía onEdit(e).
 * - FIX "MAX KWF" / "MAX TI", FIX "% CARGA" energía, FIX "CARGA TI KW".
 * - FIX NOVEDADES: leerNovedades() lee "Observacion-Operacion".
 */

const SHEET_CLIMA = "temp-humedad";
const SHEET_ENERGIA = "UPS";
const SHEET_CHILLER = "CHILLER";
const SHEET_NOVEDADES = "Observacion-Operacion";

// Clave única para guardar el JSON ya armado en el cache del script.
const CACHE_KEY = "icetel_datos_v2";
// Tiempo (segundos) que se sirve el mismo dato cacheado antes de recalcular.
const CACHE_TTL_SEGUNDOS = 12;

// NUEVO STAND BY: cantidad de equipos que cada sala necesita FUNCIONANDO
// (OK, o funcionando vía el otro circuito) para llegar al 100% de KWF.
// La clave debe ser el nombre de la sala tal como aparece en tus hojas,
// pasado por normalizar() (minúsculas, sin tildes, espacios colapsados).
// Ejemplo: si en la hoja la sala se llama "CPD1", la clave es normalizar('CPD1') = 'cpd1'.
//
// Si una sala NO aparece en este objeto, se usa como respaldo el total de
// equipos físicos de esa sala (igual que el cálculo anterior, sin STAND BY),
// así ninguna sala se rompe mientras vas completando esta tabla.
//
// AJUSTA ESTOS VALORES a los nombres y cantidades reales de tus salas:
const EQUIPOS_NECESARIOS_POR_SALA = {
  "tic 8": 2,
  conmutacion: 2,
  "baterias e2": 2,
  cpd2: 2,
  mainframe: 2,
  "gsm y prepago": 2,
  cpd1: 3,
  "cross connect": 1,
  movil: 1,
  m8: 1,
};

function doGet(e) {
  const cache = CacheService.getScriptCache();

  // 1) Intento rápido: si ya hay algo fresco en cache, se sirve directo.
  try {
    const cacheado = cache.get(CACHE_KEY);
    if (cacheado) {
      return ContentService.createTextOutput(cacheado).setMimeType(
        ContentService.MimeType.JSON,
      );
    }
  } catch (err) {
    // Si el cache falla por lo que sea, seguimos y calculamos igual.
  }

  // 2) Nadie tiene el dato fresco: se toma un lock para que, si varias
  //    pantallas llegan a la vez con el cache vacío, SOLO UNA lea la
  //    planilla y las demás esperen ese resultado.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000); // espera hasta 10s a que la otra ejecución termine

    // Doble chequeo: mientras esperábamos el lock, quizás otra ejecución ya dejó el dato listo.
    const cacheadoTrasEsperar = cache.get(CACHE_KEY);
    if (cacheadoTrasEsperar) {
      return ContentService.createTextOutput(cacheadoTrasEsperar).setMimeType(
        ContentService.MimeType.JSON,
      );
    }

    const json = JSON.stringify(construirResultado());
    try {
      cache.put(CACHE_KEY, json, CACHE_TTL_SEGUNDOS);
    } catch (err) {
      // No pasa nada si falla el cacheo, se devuelve igual.
    }
    return ContentService.createTextOutput(json).setMimeType(
      ContentService.MimeType.JSON,
    );
  } finally {
    lock.releaseLock();
  }
}

function onEdit(e) {
  try {
    CacheService.getScriptCache().remove(CACHE_KEY);
  } catch (err) {
    // Si esto falla no es crítico.
  }
}

function construirResultado() {
  const resultado = {
    ok: true,
    salas: [],
    energia: [],
    chillers: [],
    novedades: [],
    actualizado: new Date().toISOString(),
  };

  try {
    resultado.salas = leerClima();

    const capFrig = leerCapacidadFrigorifica();
    const capNom = leerCapacidadNominal();
    const kwfInfo = leerKwFKwTI();

    resultado.salas = resultado.salas.map((s) => {
      const claveSala = normalizar(s.nombre);
      const capF = capFrig[claveSala];
      const nominal = capNom[claveSala];
      const infoTi = kwfInfo[claveSala];

      if (nominal !== undefined && nominal !== null) {
        s.maxKwf = nominal;
      }
      if (
        infoTi &&
        infoTi.totalCapTi !== null &&
        infoTi.totalCapTi !== undefined
      ) {
        s.maxTi = infoTi.totalCapTi;
      }

      // 1. Cálculo de KWF (Capacidad Frigorífica)
      // NUEVO STAND BY: ya no es "suma de val / cantidad de equipos que existen".
      // Ahora es "equipos funcionando (suma de val, excluyendo los 100% STAND BY)
      // dividido por equipos NECESARIOS (configurados)".
      if (
        capF &&
        capF.totalEquipos > 0 &&
        nominal !== undefined &&
        nominal !== null
      ) {
        const equiposNecesarios =
          EQUIPOS_NECESARIOS_POR_SALA[claveSala] !== undefined
            ? EQUIPOS_NECESARIOS_POR_SALA[claveSala]
            : capF.totalEquipos; // respaldo: sala no configurada -> comportamiento anterior

        const porcentajeOperativo =
          equiposNecesarios > 0
            ? Math.min(capF.sumaFuncionando / equiposNecesarios, 1)
            : 0;

        const kwActual = porcentajeOperativo * nominal;
        s.kw = Number(kwActual.toFixed(1));
        s.porcentajeOperativo = Number((porcentajeOperativo * 100).toFixed(1));
      }

      // 1.b FIX MODAL: se adjunta el detalle por equipo/circuito
      if (capF && capF.detalle && capF.detalle.length > 0) {
        s.detalleKwf = capF.detalle;
      }

      // 2. Cálculo de Carga TI (%) y asignación de Carga TI (kW)
      if (infoTi) {
        // Asignamos explícitamente el valor absoluto para que no salga "—" en el frontend
        if (infoTi.cargaTiKw !== null && infoTi.cargaTiKw !== undefined) {
          s.cargaTiKw = infoTi.cargaTiKw;
        }

        // Calculamos el porcentaje
        if (
          infoTi.cargaTiKw !== null &&
          infoTi.totalCapTi !== null &&
          infoTi.totalCapTi > 0
        ) {
          const pctTi = (infoTi.cargaTiKw / infoTi.totalCapTi) * 100;
          s.cargaTi = Number(pctTi.toFixed(1));
        }
      }

      return s;
    });
  } catch (err) {
    resultado.ok = false;
    resultado.error = "Clima: " + err.message;
  }

  try {
    resultado.energia = leerEnergia();
  } catch (err) {
    resultado.errorEnergia = err.message;
  }

  try {
    resultado.chillers = leerChiller();
  } catch (err) {
    resultado.errorChiller = err.message;
  }

  try {
    resultado.novedades = leerNovedades();
  } catch (err) {
    resultado.errorNovedades = err.message;
    resultado.novedades = [];
  }

  return resultado;
}

// ================== CHILLER ==================
function leerChiller() {
  const sheet =
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CHILLER);
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0].map(normalizar);
  const idx = {
    equipo: buscarColumna(headers, ["equipo"]),
    tempSurtidor: buscarColumna(headers, [
      "temperatura surtidor",
      "temp surtidor",
    ]),
    tempRetorno: buscarColumna(headers, [
      "temperatura retorno",
      "temp retorno",
    ]),
    fechaTermino: buscarColumna(headers, ["fecha termino", "fecha término"]),
  };

  const idxStatusCompresores = [];
  for (let i = 0; i < headers.length; i++) {
    if (
      headers[i].includes("status compresor") ||
      headers[i].includes("estado compresor")
    ) {
      idxStatusCompresores.push(i);
    }
  }

  if (idx.equipo === -1) return [];

  const ultimoPorEquipo = {};
  for (let i = 1; i < data.length; i++) {
    const fila = data[i];
    const nombreEquipo = String(fila[idx.equipo] || "").trim();
    if (!nombreEquipo) continue;

    const fecha = idx.fechaTermino !== -1 ? fila[idx.fechaTermino] : null;
    const fechaMs = fecha instanceof Date ? fecha.getTime() : i;

    if (
      !ultimoPorEquipo[nombreEquipo] ||
      fechaMs >= ultimoPorEquipo[nombreEquipo]._fechaMs
    ) {
      const statusComp = idxStatusCompresores.map((colIdx) =>
        String(fila[colIdx] || "").trim(),
      );
      ultimoPorEquipo[nombreEquipo] = {
        fila: fila,
        _fechaMs: fechaMs,
        statusComp: statusComp,
      };
    }
  }

  return Object.keys(ultimoPorEquipo).map((nombreEquipo, i) => {
    const registro = ultimoPorEquipo[nombreEquipo];
    const fila = registro.fila;
    return {
      id: "chiller-" + (i + 1),
      tipo: "chiller",
      equipo: nombreEquipo,
      tempSurtidor:
        idx.tempSurtidor !== -1 ? numeroONull(fila[idx.tempSurtidor]) : null,
      tempRetorno:
        idx.tempRetorno !== -1 ? numeroONull(fila[idx.tempRetorno]) : null,
      statusCompresores: registro.statusComp || [],
    };
  });
}

// ================== CLIMA (temp-humedad) ==================
function leerClima() {
  const sheet =
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CLIMA);
  if (!sheet) throw new Error('No se encontró la hoja "' + SHEET_CLIMA + '"');

  const data = sheet.getDataRange().getValues();
  if (data.length < 2)
    throw new Error('La hoja "' + SHEET_CLIMA + '" no tiene datos');

  const headers = data[0].map(normalizar);
  const idx = {
    sala: buscarColumna(headers, ["sala"]),
    equipo: buscarColumna(headers, ["equipo"]),
    tipoEquipo: buscarColumna(headers, ["tipo equipo"]),
    temperatura: buscarColumna(headers, ["temperatura"]),
    humedad: buscarColumna(headers, ["humedad"]),
    estado: buscarColumna(headers, ["estado"]),
    alarmas: buscarColumna(headers, ["alarmas"]),
    fechaTermino: buscarColumna(headers, ["fecha termino", "fecha término"]),
    maximo: buscarColumna(headers, ["maximo", "máximo"]),
    kw: buscarColumna(headers, ["kw", "consumo frigorifico"]),
    cargaTi: buscarColumna(headers, ["carga ti"]),
    condicionManual: buscarColumna(headers, ["condicion", "condición"]),
  };

  if (idx.sala === -1 || idx.equipo === -1)
    throw new Error('No se encontró columna "Sala" o "Equipo"');

  const ultimoPorEquipo = {};
  for (let i = 1; i < data.length; i++) {
    const fila = data[i];
    const nombreSala = String(fila[idx.sala] || "").trim();
    const nombreEquipo = String(fila[idx.equipo] || "").trim();
    if (!nombreSala || !nombreEquipo) continue;

    const clave = nombreSala + "||" + nombreEquipo;
    const fecha = idx.fechaTermino !== -1 ? fila[idx.fechaTermino] : null;
    const fechaMs = fecha instanceof Date ? fecha.getTime() : i;

    if (!ultimoPorEquipo[clave] || fechaMs >= ultimoPorEquipo[clave]._fechaMs) {
      ultimoPorEquipo[clave] = {
        sala: nombreSala,
        equipo: nombreEquipo,
        fila: fila,
        _fechaMs: fechaMs,
      };
    }
  }

  const salasMap = {};
  Object.keys(ultimoPorEquipo).forEach((clave) => {
    const registro = ultimoPorEquipo[clave];
    const fila = registro.fila;
    const nombreSala = registro.sala;

    if (!salasMap[nombreSala]) {
      salasMap[nombreSala] = {
        nombre: nombreSala,
        equipos: [],
        _sumaTemp: 0,
        _countTemp: 0,
        _sumaHum: 0,
        _countHum: 0,
        maximo: idx.maximo !== -1 ? numeroONull(fila[idx.maximo]) : null,
        kw: idx.kw !== -1 ? numeroONull(fila[idx.kw]) : null,
        cargaTi: idx.cargaTi !== -1 ? numeroONull(fila[idx.cargaTi]) : null,
        condicionManual:
          idx.condicionManual !== -1
            ? String(fila[idx.condicionManual] || "").trim() || null
            : null,
        _hayAlarma: false,
        _hayEstadoRaro: false,
      };
    }

    const sala = salasMap[nombreSala];
    const temp = idx.temperatura !== -1 ? Number(fila[idx.temperatura]) : NaN;
    const hum = idx.humedad !== -1 ? Number(fila[idx.humedad]) : NaN;
    const estado =
      idx.estado !== -1 ? String(fila[idx.estado] || "").trim() : null;
    const alarmas = idx.alarmas !== -1 ? numeroONull(fila[idx.alarmas]) : null;

    if (!isNaN(temp)) {
      sala._sumaTemp += temp;
      sala._countTemp++;
    }
    if (!isNaN(hum)) {
      sala._sumaHum += hum;
      sala._countHum++;
    }
    if (alarmas && alarmas > 0) sala._hayAlarma = true;
    if (estado && estado.toUpperCase() !== "OK") sala._hayEstadoRaro = true;

    sala.equipos.push({
      nombre: registro.equipo,
      tipo:
        idx.tipoEquipo !== -1
          ? String(fila[idx.tipoEquipo] || "").trim()
          : null,
      temperatura: !isNaN(temp) ? temp : null,
      humedad: !isNaN(hum) ? hum : null,
      estado: estado,
      alarmas: alarmas,
    });
  });

  return Object.keys(salasMap).map((nombre, i) => {
    const s = salasMap[nombre];
    return {
      id: i + 1,
      nombre: s.nombre,
      maximo: s.maximo,
      temperatura: s._countTemp
        ? Number((s._sumaTemp / s._countTemp).toFixed(1))
        : null,
      humedad: s._countHum ? Math.round(s._sumaHum / s._countHum) : null,
      kw: s.kw,
      cargaTi: s.cargaTi, // Este es el porcentaje anterior que quizás ya no uses si usas s.cargaTiKw
      condicion:
        s.condicionManual ||
        calcularCondicionSala(s._hayAlarma, s._hayEstadoRaro),
      equipos: s.equipos || [],
    };
  });
}

// ================== ENERGÍA (UPS) ==================
function leerEnergia() {
  const sheet =
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ENERGIA);
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0].map(normalizar);
  const idx = {
    equipo: buscarColumna(headers, ["equipo"]),
    kva: buscarColumna(headers, ["kva inicio", "kva"]),
    kvaTermino: buscarColumna(headers, ["kva termino", "kva término"]),
    cargaPct: buscarColumna(headers, ["porcentaje carga"]),
    fechaTermino: buscarColumna(headers, ["fecha termino", "fecha término"]),
  };

  if (idx.equipo === -1) return [];

  const ultimoPorEquipo = {};
  for (let i = 1; i < data.length; i++) {
    const fila = data[i];
    const nombreEquipo = String(fila[idx.equipo] || "").trim();
    if (!nombreEquipo) continue;

    const fecha = idx.fechaTermino !== -1 ? fila[idx.fechaTermino] : null;
    const fechaMs = fecha instanceof Date ? fecha.getTime() : i;

    if (
      !ultimoPorEquipo[nombreEquipo] ||
      fechaMs >= ultimoPorEquipo[nombreEquipo]._fechaMs
    ) {
      ultimoPorEquipo[nombreEquipo] = { fila: fila, _fechaMs: fechaMs };
    }
  }

  return Object.keys(ultimoPorEquipo).map((nombreEquipo, i) => {
    const fila = ultimoPorEquipo[nombreEquipo].fila;

    const kvaInicio = idx.kva !== -1 ? numeroONull(fila[idx.kva]) : null;
    const kvaTermino =
      idx.kvaTermino !== -1 ? numeroONull(fila[idx.kvaTermino]) : null;
    let porcentajeCarga =
      idx.cargaPct !== -1 ? numeroONull(fila[idx.cargaPct]) : null;

    if (
      (porcentajeCarga === null || porcentajeCarga === undefined) &&
      kvaInicio !== null &&
      kvaInicio > 0 &&
      kvaTermino !== null
    ) {
      porcentajeCarga = Number(((kvaTermino / kvaInicio) * 100).toFixed(1));
    }

    return {
      id: i + 1,
      equipo: nombreEquipo,
      kvaInicio: kvaInicio,
      kvaTermino: kvaTermino,
      porcentajeCarga: porcentajeCarga,
    };
  });
}

// ================== NOVEDADES (Observacion-Operacion) ==================
function leerNovedades() {
  const sheet =
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NOVEDADES);
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0].map(normalizar);
  const idx = {
    fecha: buscarColumna(headers, ["fecha"]),
    area: buscarColumna(headers, ["area", "área"]),
    sala: buscarColumna(headers, ["sala"]),
    equipo: buscarColumna(headers, ["equipo"]),
    observacion: buscarColumna(headers, ["observacion", "observación"]),
  };

  const lista = [];
  for (let i = 1; i < data.length; i++) {
    const fila = data[i];
    const observacion =
      idx.observacion !== -1 ? String(fila[idx.observacion] || "").trim() : "";
    if (!observacion) continue; // saltar filas vacías

    const fechaRaw = idx.fecha !== -1 ? fila[idx.fecha] : null;
    const fecha =
      fechaRaw instanceof Date
        ? Utilities.formatDate(
            fechaRaw,
            Session.getScriptTimeZone(),
            "dd-MM-yyyy",
          )
        : String(fechaRaw || "");

    const equipo =
      idx.equipo !== -1 ? String(fila[idx.equipo] || "").trim() : "";
    const sala = idx.sala !== -1 ? String(fila[idx.sala] || "").trim() : "";

    lista.push({
      area: idx.area !== -1 ? String(fila[idx.area] || "").trim() : "",
      // Se combina sala + equipo para no perder el detalle del equipo en el modal,
      // que solo muestra n.sala en su encabezado.
      sala: equipo ? sala + " - " + equipo : sala,
      fecha: fecha,
      observacion: observacion,
    });
  }

  return lista;
}

// ================== HELPERS COMPARTIDOS ==================
function calcularCondicionSala(hayAlarma, hayEstadoRaro) {
  if (hayAlarma) return "Crítica";
  if (hayEstadoRaro) return "Alerta";
  return "Óptima";
}

function normalizar(texto) {
  return String(texto || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buscarColumna(headers, posibles) {
  for (let j = 0; j < posibles.length; j++) {
    const p = normalizar(posibles[j]);
    const iExacto = headers.indexOf(p);
    if (iExacto !== -1) return iExacto;
  }
  for (let j = 0; j < posibles.length; j++) {
    const p = normalizar(posibles[j]);
    if (p.length < 4) continue;
    for (let i = 0; i < headers.length; i++) {
      if (headers[i].indexOf(p) !== -1) return i;
    }
  }
  return -1;
}

function numeroONull(valor) {
  if (valor === "" || valor === null || valor === undefined) return null;
  if (typeof valor === "string") {
    valor = valor.replace(/,/g, ".");
    const partes = valor.split(".");
    if (partes.length > 2) {
      valor = partes[0] + "." + partes.slice(1).join("");
    }
  }
  const n = Number(valor);
  return isNaN(n) ? null : n;
}

// ================== NUEVO STAND BY: NORMALIZACIÓN Y CÁLCULO POR EQUIPO ==================

// Normaliza el texto de un circuito a un estado canónico, tolerando
// variantes de escritura para STAND BY ("STAND BY", "STANDBY", "Stand By",
// "stand by", "standby" -> 'STANDBY'). OK/NOK/N-A se normalizan igual que antes.
function normalizarEstadoCircuito(valorRaw) {
  const limpio = String(valorRaw || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  // Quita espacios, guiones y barras para poder comparar "STAND BY" == "STANDBY"
  // y "N/A" == "NA" de forma robusta.
  const sinSeparadores = limpio.replace(/[\s\-_/]/g, "");

  if (sinSeparadores === "STANDBY") return "STANDBY";
  if (sinSeparadores === "OK") return "OK";
  if (sinSeparadores === "NOK") return "NOK";
  if (sinSeparadores === "NA") return "N/A";
  if (!limpio) return "";
  return limpio; // estado desconocido: se conserva tal cual, no se inventa un valor
}

// Texto a mostrar en el frontend para cada estado canónico.
function textoEstadoCircuito(estado) {
  if (estado === "STANDBY") return "STAND BY";
  if (estado === "") return "—";
  return estado; // 'OK', 'NOK', 'N/A' o cualquier valor crudo desconocido
}

// Calcula el aporte (val) de un equipo según sus 2 circuitos ya normalizados.
// Devuelve:
//   - null  -> el equipo completo está en STAND BY (ambos circuitos, o el
//              único circuito informado). Se EXCLUYE del cálculo de KWF:
//              no suma ni resta capacidad.
//   - 1.0 / 0.5 / 0.0 -> aporte normal (misma escala que la lógica anterior).
function calcularValEquipo(c1, c2) {
  const esOk = (x) => x === "OK";
  const esNok = (x) => x === "NOK";
  const esStandBy = (x) => x === "STANDBY";
  const esNaOVacio = (x) => x === "N/A" || !x;

  // Equipo completo en STAND BY (los 2 circuitos, o el único circuito informado)
  if (esStandBy(c1) && (esStandBy(c2) || !c2)) return null;
  if (!c1 && esStandBy(c2)) return null;

  // Ambos circuitos OK, o uno OK y el otro N/A -> 100%
  if (esOk(c1) && esOk(c2)) return 1.0;
  if (esOk(c1) && esNaOVacio(c2)) return 1.0;
  if (esNaOVacio(c1) && esOk(c2)) return 1.0;

  // NUEVO STAND BY: un circuito OK y el otro en STAND BY -> el equipo queda
  // funcionando al 50% con el circuito disponible

  // Un circuito OK y el otro NOK -> 50%
  if (esOk(c1) && esStandBy(c2)) return 0.5;
  if (esStandBy(c1) && esOk(c2)) return 0.5;
  if (esOk(c1) && esNok(c2)) return 0.5;
  if (esNok(c1) && esOk(c2)) return 0.5;

  // Ambos NOK, o uno NOK y el otro N/A -> 0%
  if (esNok(c1) && esNok(c2)) return 0.0;
  if (esNok(c1) && esNaOVacio(c2)) return 0.0;
  if (esNaOVacio(c1) && esNok(c2)) return 0.0;

  // NUEVO STAND BY: un circuito NOK y el otro en STAND BY -> hay una falla
  // real (el NOK), así que el equipo cuenta como caído (0%). No se excluye,
  // porque no es un apagado 100% intencional.
  if (esNok(c1) && esStandBy(c2)) return 0.0;
  if (esStandBy(c1) && esNok(c2)) return 0.0;

  return 0.0; // combinación no reconocida: se trata como no funcionando
}

// ================== CAPACIDAD FRIGORÍFICA Y CIRCUITO ==================
function leerCapacidadFrigorifica() {
  const sheet =
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Cap-Frigorifica");
  if (!sheet) return {};

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};
  const headers = data[0].map(normalizar);
  const idx = {
    sala: buscarColumna(headers, ["sala"]),
    equipo: buscarColumna(headers, [
      "equipo",
      "unidad",
      "nombre circuito",
      "circuito climatizacion",
    ]),
    c1: buscarColumna(headers, ["circuito 1"]),
    c2: buscarColumna(headers, ["circuito 2"]),
  };

  if (idx.sala === -1 || idx.c1 === -1 || idx.c2 === -1) return {};

  const salasCap = {};
  for (let i = 1; i < data.length; i++) {
    const fila = data[i];
    const salaRaw = String(fila[idx.sala] || "").trim();
    if (!salaRaw) continue;
    const sala = normalizar(salaRaw);

    // NUEVO STAND BY: normalización tolerante de escritura
    const c1 = normalizarEstadoCircuito(fila[idx.c1]);
    const c2 = normalizarEstadoCircuito(fila[idx.c2]);

    const val = calcularValEquipo(c1, c2); // NUEVO STAND BY: puede ser null

    if (!salasCap[sala])
      salasCap[sala] = { sumaFuncionando: 0, totalEquipos: 0, detalle: [] };
    salasCap[sala].totalEquipos += 1;
    if (val !== null) {
      // NUEVO STAND BY: los equipos 100% STAND BY no aportan a esta suma.
      salasCap[sala].sumaFuncionando += val;
    }

    const nombreEquipo =
      idx.equipo !== -1
        ? String(fila[idx.equipo] || "").trim() ||
          "Circuito " + (salasCap[sala].detalle.length + 1)
        : "Circuito " + (salasCap[sala].detalle.length + 1);

    salasCap[sala].detalle.push({
      equipo: nombreEquipo,
      c1: textoEstadoCircuito(c1), // NUEVO STAND BY: puede ser 'STAND BY'
      c2: textoEstadoCircuito(c2), // NUEVO STAND BY: puede ser 'STAND BY'
      val: val, // NUEVO STAND BY: null si el equipo está 100% en STAND BY
      standBy: val === null, // NUEVO STAND BY: bandera explícita para el frontend
    });
  }
  return salasCap;
}

// ================== CAPACIDAD NOMINAL KWF ==================
function leerCapacidadNominal() {
  const sheet =
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName("KwF-KwTI");
  if (!sheet) return {};

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};
  const headers = data[0].map(normalizar);
  const idx = {
    sala: buscarColumna(headers, ["sala"]),
    capNominal: buscarColumna(headers, [
      "capacidad nominal kwf",
      "capacidad nominal",
    ]),
  };

  if (idx.sala === -1 || idx.capNominal === -1) return {};

  const salasNominal = {};
  for (let i = 1; i < data.length; i++) {
    const fila = data[i];
    const salaRaw = String(fila[idx.sala] || "").trim();
    if (!salaRaw) continue;
    const sala = normalizar(salaRaw);

    const nominal = numeroONull(fila[idx.capNominal]);
    if (nominal !== null) salasNominal[sala] = nominal;
  }
  return salasNominal;
}

// ================== LECTURA DE CARGA TI ==================
function leerKwFKwTI() {
  const sheet =
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName("KwF-KwTI");
  if (!sheet) return {};

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};
  const headers = data[0].map(normalizar);

  const idx = {
    sala: buscarColumna(headers, ["sala"]),
    cargaTiKw: buscarColumna(headers, ["carga ti (kw)", "carga ti"]),
    totalCapTi: buscarColumna(headers, [
      "total capacity (kw) ti",
      "total capacity ti",
    ]),
  };

  if (idx.sala === -1) return {};

  const kwfData = {};
  for (let i = 1; i < data.length; i++) {
    const fila = data[i];
    const salaRaw = String(fila[idx.sala] || "").trim();
    if (!salaRaw) continue;

    const salaKey = normalizar(salaRaw);

    const cargaVal =
      idx.cargaTiKw !== -1 ? numeroONull(fila[idx.cargaTiKw]) : null;
    const capVal =
      idx.totalCapTi !== -1 ? numeroONull(fila[idx.totalCapTi]) : null;

    kwfData[salaKey] = {
      cargaTiKw: cargaVal,
      totalCapTi: capVal,
    };
  }
  return kwfData;
}
