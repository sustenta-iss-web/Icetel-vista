import React, { useState, useEffect, useCallback, useRef } from "react";

// --- CONFIGURACIÓN ---
const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwVRISt9dGOt0lXWimGVCkH2jLmWKHL1h-CLNEBymE6Q9gp_WOeJzTTUh6cKjqynBms/exec";
const ITEMS_POR_PAGINA = 6;
const INTERVALO_DATOS_MS = 15000;
const JITTER_MAX_MS = 4000;
const INTERVALO_PAGINA_MS = 10000;
const FALLOS_CONSECUTIVOS_PARA_AVISAR = 3;
const STORAGE_KEY = "icetel_cache_datos_v1";

// --- COLORES DE ESTADO (umbrales) ---
// Paleta "radioactiva": saturación y luminosidad al máximo para que el
// contraste se note incluso en TVs viejas / paneles LCD desgastados que
// desaturan y oscurecen los tonos intermedios.
const COLOR_PREOCUPANTE = "#FF0044";
const COLOR_KWF_OK = "#00FF66";
const COLOR_ENERGIA_OK = "#5dceffef";
const COLOR_CARGA_TI = "#FF6A00";
const COLOR_UPS_KW = "#ffe251";
const UMBRAL_KWF = 50;
const UMBRAL_CARGA_UPS = 80;
const UMBRAL_TEMP = 28;

const hexA = (hex, alpha) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

// Devuelve un color de texto (blanco casi puro o gris muy oscuro) que
// contrasta bien sobre un fondo plano `hex`, usando la fórmula de brillo YIQ.
const getContrastText = (hex) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140 ? "#0f172a" : "#f8fafc";
};

const TEXTO_CARGA_TI = getContrastText(COLOR_CARGA_TI);
const TEXTO_UPS_KW = getContrastText(COLOR_UPS_KW);

const fmt = (valor, sufijo = "") =>
  valor === null || valor === undefined || valor === "" || isNaN(valor)
    ? "—"
    : `${valor}${sufijo}`;

const fmtPorcentaje = (valor) => {
  if (valor === null || valor === undefined || valor === "") return "—";
  if (typeof valor === "number") {
    let num = valor;
    if (num > 100) {
      let s_dig = String(Math.floor(num));
      if (s_dig.length >= 3) {
        num = Number(s_dig.slice(0, 2) + "." + s_dig.slice(2));
      }
    }
    return `${num.toFixed(1)}%`;
  }
  try {
    let s = String(valor).trim().replace(/\s+/g, "");
    s = s.replace(/,/g, ".");
    const parts = s.split(".");
    if (parts.length > 2) {
      s = parts[0] + "." + parts.slice(1).join("");
    }
    let num = Number(s);
    if (isNaN(num)) return "—";
    if (num > 100) {
      let s_dig = String(Math.floor(num));
      if (s_dig.length >= 3) {
        num = Number(s_dig.slice(0, 2) + "." + s_dig.slice(2));
      }
    }
    return `${num.toFixed(1)}%`;
  } catch (e) {
    return "—";
  }
};

// --- HOOKS ---
const useResponsiveLayout = () => {
  const calcular = () => {
    if (typeof window === "undefined")
      return { ancho: 1200, columnas: 3, esPantallaGrande: true };
    const ancho = window.innerWidth;
    const alto = window.innerHeight;
    const esLandscape = ancho > alto;
    const columnas = esLandscape || ancho >= 640 ? 3 : 2;
    const esPantallaGrande = esLandscape;
    return { ancho, columnas, esPantallaGrande };
  };
  const [layout, setLayout] = useState(calcular);
  useEffect(() => {
    const onResize = () => setLayout(calcular());
    const onOrientationChange = () => {
      onResize();
      setTimeout(onResize, 150);
      setTimeout(onResize, 400);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onOrientationChange);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onOrientationChange);
    };
  }, []);
  return layout;
};

const useAlturaDisponible = (margenInferior) => {
  const ref = useRef(null);
  const [altura, setAltura] = useState(0);
  useEffect(() => {
    let activo = true;
    const medir = () => {
      if (!activo || !ref.current) return;
      const top = ref.current.getBoundingClientRect().top;
      const disponible = Math.max(0, window.innerHeight - top - margenInferior);
      setAltura((prev) =>
        Math.abs(prev - disponible) > 1 ? disponible : prev,
      );
    };
    medir();
    window.addEventListener("resize", medir);
    window.addEventListener("orientationchange", medir);
    let observer = null;
    if (
      typeof window !== "undefined" &&
      typeof window.ResizeObserver !== "undefined"
    ) {
      observer = new window.ResizeObserver(medir);
      observer.observe(document.documentElement);
    }
    const intervalo = setInterval(medir, 1000);
    return () => {
      activo = false;
      window.removeEventListener("resize", medir);
      window.removeEventListener("orientationchange", medir);
      if (observer) observer.disconnect();
      clearInterval(intervalo);
    };
  }, [margenInferior]);
  return [ref, altura];
};

// --- MODALES ---
const ModalDetalle = ({ config, onClose }) => {
  const { sala, metrica } = config;
  if (!sala || !metrica) return null;

  let titulo = "";
  let contenido = null;

  if (metrica === "temperatura") {
    titulo = `Temperaturas - ${sala.nombre}`;
    contenido = (
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {!sala.equipos || sala.equipos.length === 0 ? (
          <p
            style={{
              color: "var(--text-muted)",
              fontSize: "14px",
              textAlign: "center",
              padding: "16px",
            }}
          >
            No hay equipos registrados.
          </p>
        ) : (
          sala.equipos.map((eq, i) => (
            <div
              key={i}
              style={{
                backgroundColor: "var(--bg-card-subtle)",
                borderRadius: "10px",
                padding: "10px 14px",
                border: "1px solid var(--border-subtle)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ fontWeight: "bold", color: "var(--text-primary)" }}>
                {eq.nombre || "Equipo"}
              </span>
              <span
                style={{
                  color: "var(--metric-temp-text)",
                  fontWeight: "bold",
                  fontSize: "14px",
                }}
              >
                {fmt(eq.temperatura, "°C")}
              </span>
            </div>
          ))
        )}
      </div>
    );
  } else if (metrica === "humedad") {
    titulo = `Humedad - ${sala.nombre}`;
    contenido = (
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {!sala.equipos || sala.equipos.length === 0 ? (
          <p
            style={{
              color: "var(--text-muted)",
              fontSize: "14px",
              textAlign: "center",
              padding: "16px",
            }}
          >
            No hay equipos registrados.
          </p>
        ) : (
          sala.equipos.map((eq, i) => (
            <div
              key={i}
              style={{
                backgroundColor: "var(--bg-card-subtle)",
                borderRadius: "10px",
                padding: "10px 14px",
                border: "1px solid var(--border-subtle)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ fontWeight: "bold", color: "var(--text-primary)" }}>
                {eq.nombre || "Equipo"}
              </span>
              <span
                style={{
                  color: "var(--metric-hum-text)",
                  fontWeight: "bold",
                  fontSize: "14px",
                }}
              >
                {fmt(eq.humedad, "%")}
              </span>
            </div>
          ))
        )}
      </div>
    );
  } else if (metrica === "kwf") {
    titulo = `Estado de Circuitos KWF - ${sala.nombre}`;
    contenido = (
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {!sala.detalleKwf || sala.detalleKwf.length === 0 ? (
          <p
            style={{
              color: "var(--text-muted)",
              fontSize: "14px",
              textAlign: "center",
              padding: "16px",
            }}
          >
            No hay detalle de circuitos registrado.
          </p>
        ) : (
          sala.detalleKwf.map((eq, i) => (
            <div
              key={i}
              style={{
                backgroundColor: "var(--bg-card-subtle)",
                borderRadius: "10px",
                padding: "10px",
                border: "1px solid var(--border-subtle)",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  borderBottom: "1px solid var(--border-subtle)",
                  paddingBottom: "6px",
                }}
              >
                <span style={{ fontWeight: "bold", color: "var(--text-primary)" }}>
                  {sala.nombre} - {eq.equipo}
                </span>
                <span
                  style={{
                    padding: "3px 8px",
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 700,
                    backgroundColor:
                      eq.val === null
                        ? "rgba(251, 191, 36, 0.15)"
                        : eq.val === 1
                          ? "rgba(52, 211, 153, 0.15)"
                          : eq.val === 0.5
                            ? "rgba(251, 191, 36, 0.15)"
                            : "rgba(248, 113, 113, 0.15)",
                    color:
                      eq.val === null
                        ? "#fbbf24"
                        : eq.val === 1
                          ? "#10b981"
                          : eq.val === 0.5
                            ? "#fbbf24"
                            : "#f87171",
                  }}
                >
                  {eq.val === null ? "STAND BY" : `${eq.val * 100}%`}
                </span>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <div
                  style={{
                    flex: 1,
                    backgroundColor: "var(--badge-bg)",
                    padding: "8px",
                    borderRadius: "6px",
                    border: "1px solid var(--badge-border)",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                    Circuito 1
                  </span>
                  <span
                    style={{
                      fontSize: "12px",
                      fontWeight: "bold",
                      color:
                        eq.c1 === "OK"
                          ? "#10b981"
                          : eq.c1 === "NOK"
                            ? "#ef4444"
                            : eq.c1 === "STAND BY"
                              ? "#f59e0b"
                              : "var(--text-muted)",
                    }}
                  >
                    {eq.c1}
                  </span>
                </div>
                <div
                  style={{
                    flex: 1,
                    backgroundColor: "var(--badge-bg)",
                    padding: "8px",
                    borderRadius: "6px",
                    border: "1px solid var(--badge-border)",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                    Circuito 2
                  </span>
                  <span
                    style={{
                      fontSize: "12px",
                      fontWeight: "bold",
                      color:
                        eq.c2 === "OK"
                          ? "#10b981"
                          : eq.c2 === "NOK"
                            ? "#ef4444"
                            : eq.c2 === "STAND BY"
                              ? "#f59e0b"
                              : "var(--text-muted)",
                    }}
                  >
                    {eq.c2}
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    );
  } else if (metrica === "cargati") {
    titulo = `Detalle Carga TI - ${sala.nombre}`;
    contenido = (
      <div
        style={{
          backgroundColor: "var(--bg-card-subtle)",
          borderRadius: "10px",
          padding: "16px",
          border: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--border-subtle)",
            paddingBottom: "8px",
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>Capacidad Total TI (Máx TI)</span>
          <span style={{ color: "var(--text-primary)", fontWeight: "bold" }}>
            {fmt(sala.maxTi, " kW")}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--border-subtle)",
            paddingBottom: "8px",
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>Carga TI Actual</span>
          <span style={{ color: "#f97316", fontWeight: "bold" }}>
            {fmt(sala.cargaTiKw, " kW")}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>Porcentaje de Carga</span>
          <span
            style={{
              color: "#d97706",
              fontWeight: "bold",
              backgroundColor: "rgba(245, 158, 11, 0.15)",
              padding: "4px 10px",
              borderRadius: "6px",
              border: "1px solid rgba(245, 158, 11, 0.3)",
            }}
          >
            {fmtPorcentaje(sala.cargaTi)}
          </span>
        </div>
      </div>
    );
  } else if (metrica === "energia") {
    titulo = `Detalle UPS - ${sala.equipo}`;
    contenido = (
      <div
        style={{
          backgroundColor: "var(--bg-card-subtle)",
          borderRadius: "10px",
          padding: "16px",
          border: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--border-subtle)",
            paddingBottom: "8px",
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>KVA Inicio</span>
          <span style={{ color: "var(--header-energia)", fontWeight: "bold" }}>
            {fmt(sala.kvaInicio)}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--border-subtle)",
            paddingBottom: "8px",
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>KW Término</span>
          <span style={{ color: "#6366f1", fontWeight: "bold" }}>
            {fmt(sala.kvaTermino)}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>Porcentaje Carga</span>
          <span
            style={{
              color: "#10b981",
              fontWeight: "bold",
              backgroundColor: "rgba(16, 185, 129, 0.15)",
              padding: "4px 10px",
              borderRadius: "6px",
              border: "1px solid rgba(16, 185, 129, 0.3)",
            }}
          >
            {fmtPorcentaje(sala.porcentajeCarga)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "var(--bg-modal-overlay)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "var(--bg-modal)",
          border: "1px solid var(--border-card)",
          boxShadow: "var(--shadow-card)",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "420px",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <h3
            style={{
              fontSize: "16px",
              fontWeight: "bold",
              color: "var(--text-primary)",
              margin: 0,
            }}
          >
            {titulo}
          </h3>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: "20px",
              fontWeight: "bold",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
        <div style={{ overflowY: "auto", padding: "16px" }}>{contenido}</div>
      </div>
    </div>
  );
};

const ModalNovedades = ({ novedades, onClose, columnaUnica }) => {
  if (!novedades) return null;
  const novClima = novedades.filter((n) =>
    (n.area || "").toLowerCase().includes("clima"),
  );
  const novEnergia = novedades.filter(
    (n) =>
      (n.area || "").toLowerCase().includes("energia") ||
      (n.area || "").toLowerCase().includes("energía"),
  );
  const novOtras = novedades.filter((n) => {
    const a = (n.area || "").toLowerCase();
    return (
      !a.includes("clima") && !a.includes("energia") && !a.includes("energía")
    );
  });

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "var(--bg-modal-overlay)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "var(--bg-modal)",
          border: "1px solid var(--border-card)",
          boxShadow: "var(--shadow-card)",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "800px",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          color: "var(--text-primary)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <div>
            <h3
              style={{
                fontSize: "16px",
                fontWeight: "bold",
                color: "var(--metric-hum-text)",
                margin: 0,
              }}
            >
              Novedades y Observaciones de Operación
            </h3>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: 0 }}>
              Registro reciente clasificado por área
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "var(--badge-bg)",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-muted)",
              fontSize: "18px",
              fontWeight: "bold",
              cursor: "pointer",
              padding: "4px 10px",
              borderRadius: "6px",
            }}
          >
            ×
          </button>
        </div>
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px",
            display: "flex",
            flexDirection: columnaUnica ? "column" : "row",
            gap: "16px",
          }}
        >
          <div
            style={{
              flex: 1,
              backgroundColor: "var(--bg-card-subtle)",
              padding: "12px",
              borderRadius: "10px",
              border: "1px solid var(--border-subtle)",
            }}
          >
            <h4
              style={{
                fontSize: "13px",
                fontWeight: "bold",
                color: "var(--header-clima)",
                marginBottom: "8px",
                borderBottom: "1px solid var(--header-clima-border)",
                paddingBottom: "6px",
                margin: "0 0 8px 0",
              }}
            >
              Clima ({novClima.length})
            </h4>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                maxHeight: "300px",
                overflowY: "auto",
              }}
            >
              {novClima.length === 0 ? (
                <p
                  style={{
                    color: "var(--text-muted)",
                    fontSize: "11px",
                    textAlign: "center",
                  }}
                >
                  Sin novedades en Clima.
                </p>
              ) : (
                novClima.map((n, i) => (
                  <div
                    key={i}
                    style={{
                      backgroundColor: "var(--badge-bg)",
                      padding: "8px",
                      borderRadius: "6px",
                      border: "1px solid var(--badge-border)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: "10px",
                        color: "var(--text-muted)",
                      }}
                    >
                      <span>
                        Sala: <strong style={{ color: "var(--text-primary)" }}>{n.sala || "—"}</strong>
                      </span>
                      <span style={{ color: "var(--metric-hum-text)", fontWeight: "600" }}>{n.fecha}</span>
                    </div>
                    <p
                      style={{
                        fontSize: "12px",
                        color: "var(--text-secondary)",
                        margin: "4px 0 0 0",
                      }}
                    >
                      {n.observacion}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
          <div
            style={{
              flex: 1,
              backgroundColor: "var(--bg-card-subtle)",
              padding: "12px",
              borderRadius: "10px",
              border: "1px solid var(--border-subtle)",
            }}
          >
            <h4
              style={{
                fontSize: "13px",
                fontWeight: "bold",
                color: "var(--header-energia)",
                marginBottom: "8px",
                borderBottom: "1px solid var(--header-energia-border)",
                paddingBottom: "6px",
                margin: "0 0 8px 0",
              }}
            >
              Energía ({novEnergia.length})
            </h4>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                maxHeight: "300px",
                overflowY: "auto",
              }}
            >
              {novEnergia.length === 0 ? (
                <p
                  style={{
                    color: "var(--text-muted)",
                    fontSize: "11px",
                    textAlign: "center",
                  }}
                >
                  Sin novedades en Energía.
                </p>
              ) : (
                novEnergia.map((n, i) => (
                  <div
                    key={i}
                    style={{
                      backgroundColor: "var(--badge-bg)",
                      padding: "8px",
                      borderRadius: "6px",
                      border: "1px solid var(--badge-border)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: "10px",
                        color: "var(--text-muted)",
                      }}
                    >
                      <span>
                        Sala: <strong style={{ color: "var(--text-primary)" }}>{n.sala || "—"}</strong>
                      </span>
                      <span style={{ color: "var(--metric-hum-text)", fontWeight: "600" }}>{n.fecha}</span>
                    </div>
                    <p
                      style={{
                        fontSize: "12px",
                        color: "var(--text-secondary)",
                        margin: "4px 0 0 0",
                      }}
                    >
                      {n.observacion}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
        {novOtras.length > 0 && (
          <div style={{ padding: "0 16px 16px 16px" }}>
            <p
              style={{
                fontSize: "11px",
                color: "var(--text-muted)",
                textTransform: "uppercase",
                marginBottom: "8px",
              }}
            >
              Otras áreas / General:
            </p>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                maxHeight: "128px",
                overflowY: "auto",
              }}
            >
              {novOtras.map((n, i) => (
                <div
                  key={i}
                  style={{
                    backgroundColor: "var(--badge-bg)",
                    border: "1px solid var(--badge-border)",
                    padding: "6px",
                    borderRadius: "4px",
                    fontSize: "11px",
                    display: "flex",
                    justifyContent: "space-between",
                    color: "var(--text-secondary)",
                  }}
                >
                  <span>
                    <strong style={{ color: "var(--text-primary)" }}>{n.area || "General"}</strong> - {n.sala}:{" "}
                    {n.observacion}
                  </span>
                  <span style={{ color: "var(--metric-hum-text)", fontWeight: "600" }}>{n.fecha}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// --- TARJETA CLIMA ---
// NOTA (fix parpadeo): ya no recibe `parpadeoOn`. El encendido/apagado del
// rojo lo decide únicamente la clase CSS `.efecto-baliza` (animación por
// @keyframes), y el style inline deja de tener un color condicionado al
// mismo estado crítico -> ya no compiten dos mecanismos por el mismo color.
const TarjetaClima = ({ datos, onClickMetrica }) => {
  if (!datos) return <div style={{ height: "100%", width: "100%" }}></div>;

  const pctKwf = datos.porcentajeOperativo;
  const hayDatoKwf = pctKwf !== undefined && pctKwf !== null;
  const kwfCritico = hayDatoKwf && pctKwf <= UMBRAL_KWF;
  const colorKwf = hayDatoKwf
    ? kwfCritico
      ? COLOR_PREOCUPANTE
      : COLOR_KWF_OK
    : null;
  // Color plano (sin transparencia) y su texto de contraste correspondiente
  const textoKwf = colorKwf ? getContrastText(colorKwf) : "#c084fc";

  const temp = datos.temperatura;
  const hayDatoTemp = temp !== undefined && temp !== null;
  const tempCritica = hayDatoTemp && temp >= UMBRAL_TEMP;

  const anchoKwfPct = hayDatoKwf ? Math.max(0, Math.min(100, pctKwf)) / 2 : 50;
  const anchoCargaTiPct = 100 - anchoKwfPct;
  const hayDatoCargaTi = datos.cargaTi !== undefined && datos.cargaTi !== null;

  // Antes: `tempCritica && parpadeoOn` (dependía de un setInterval de JS).
  // Ahora: solo depende de si el valor es crítico; el parpadeo lo hace el CSS.
  const claseTemp = tempCritica ? "efecto-baliza" : "";
  const claseKwf = kwfCritico ? "efecto-baliza" : "";

  return (
    <div
      style={{
        backgroundColor: "var(--bg-card)",
        borderRadius: "12px",
        boxShadow: "var(--shadow-card)",
        border: "1px solid var(--border-card)",
        borderTop: `2px solid ${kwfCritico ? COLOR_PREOCUPANTE : "var(--border-card)"}`,
        transition: "border-top-color 0.4s ease, background-color 0.25s ease, border-color 0.25s ease",
        padding: "8px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        height: "100%",
        width: "100%",
        minHeight: 0,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--border-subtle)",
          paddingBottom: "4px",
          flexShrink: 0,
        }}
      >
        <h2
          style={{
            fontSize: "12px",
            fontWeight: "bold",
            color: "var(--text-primary)",
            margin: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "55%",
          }}
        >
          {datos.nombre || "Sala"}
        </h2>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "2px",
          }}
        >
          <span
            style={{
              fontSize: "12px",
              color: "var(--badge-text)",
              backgroundColor: "var(--badge-bg)",
              padding: "2px 6px",
              borderRadius: "4px",
              border: "1px solid var(--badge-border)",
              whiteSpace: "nowrap",
            }}
          >
            Max KWF:{" "}
            <strong style={{ color: "var(--header-energia)" }}>{fmt(datos.maxKwf)}</strong>
          </span>
          <span
            style={{
              fontSize: "12px",
              color: "var(--badge-text)",
              backgroundColor: "var(--badge-bg)",
              padding: "2px 6px",
              borderRadius: "4px",
              border: "1px solid var(--badge-border)",
              whiteSpace: "nowrap",
            }}
          >
            Max TI:{" "}
            <strong style={{ color: "var(--header-energia)" }}>{fmt(datos.maxTi)}</strong>
          </span>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          flex: 1,
          minHeight: 0,
          marginTop: "6px",
        }}
      >
        {/* TEMPERATURA - el fondo/borde base es siempre el mismo (no crítico);
            si es crítico, la clase .efecto-baliza se encarga de parpadear a rojo. */}
        <button
          onClick={() => onClickMetrica(datos, "temperatura")}
          className={claseTemp}
          style={{
            width: "calc(50% - 3px)",
            height: "calc(50% - 3px)",
            marginRight: "6px",
            marginBottom: "6px",
            backgroundColor: "var(--metric-temp-bg)",
            border: "1px solid var(--metric-temp-border)",
            borderRadius: "8px",
            padding: "4px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            cursor: "pointer",
            minHeight: 0,
            boxSizing: "border-box",
          }}
        >
          <span
            style={{
              fontSize: "9px",
              fontWeight: "bold",
              color: tempCritica ? "#fff" : "var(--text-muted)",
              textTransform: "uppercase",
            }}
          >
            T°
          </span>
          <span
            style={{
              fontSize: "15px",
              fontWeight: "bold",
              color: tempCritica ? "#fff" : "var(--metric-temp-text)",
            }}
          >
            {fmt(temp, "°C")}
          </span>
        </button>

        <button
          onClick={() => onClickMetrica(datos, "humedad")}
          style={{
            width: "calc(50% - 3px)",
            height: "calc(50% - 3px)",
            marginBottom: "6px",
            backgroundColor: "var(--metric-hum-bg)",
            border: "1px solid var(--metric-hum-border)",
            borderRadius: "8px",
            padding: "4px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            cursor: "pointer",
            minHeight: 0,
            boxSizing: "border-box",
          }}
        >
          <span
            style={{
              fontSize: "9px",
              fontWeight: "bold",
              color: "var(--text-muted)",
              textTransform: "uppercase",
            }}
          >
            H%
          </span>
          <span
            style={{ fontSize: "15px", fontWeight: "bold", color: "var(--metric-hum-text)" }}
          >
            {fmt(datos.humedad, "%")}
          </span>
        </button>

        <div
          style={{
            width: "100%",
            height: "calc(50% - 3px)",
            position: "relative",
            display: "flex",
            borderRadius: "8px",
            overflow: "hidden",
            border: `1px solid ${kwfCritico ? "#ff4d5e" : "var(--border-subtle)"}`,
            boxShadow: kwfCritico
              ? `0 0 14px 2px ${hexA(COLOR_PREOCUPANTE, 0.75)}`
              : `0 0 10px 1px ${hexA(colorKwf || COLOR_CARGA_TI, 0.35)}`,
            transition: "border-color 0.4s ease, box-shadow 0.4s ease",
            minHeight: 0,
            boxSizing: "border-box",
          }}
        >
          {/* Fondo plano (sin transparencia) para que se note bien en pantallas
              antiguas: cada mitad usa directamente el color de estado, a
              máxima saturación, para que el TV lo reproduzca con fuerza. */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                width: `${anchoKwfPct}%`,
                height: "100%",
                transition: "width 0.6s ease, background-color 0.4s ease",
                backgroundColor: colorKwf || "#3b0764",
              }}
            />
            <div
              style={{
                width: `${anchoCargaTiPct}%`,
                height: "100%",
                transition: "width 0.6s ease",
                backgroundColor: COLOR_CARGA_TI,
              }}
            />
          </div>

          {kwfCritico && (
            <div
              className={claseKwf}
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "8px",
                pointerEvents: "none",
              }}
            />
          )}

          <button
            onClick={() => onClickMetrica(datos, "kwf")}
            style={{
              position: "relative",
              zIndex: 1,
              width: "50%",
              background: "transparent",
              border: "none",
              padding: "2px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              alignItems: "center",
              cursor: "pointer",
              minWidth: 0,
              boxSizing: "border-box",
            }}
          >
            <span
              style={{
                fontSize: "8px",
                fontWeight: "bold",
                color: textoKwf,
                textTransform: "uppercase",
                whiteSpace: "nowrap",
                opacity: 0.85,
              }}
            >
              KWF
            </span>
            <span
              style={{
                fontSize: "13px",
                fontWeight: "bold",
                color: textoKwf,
                whiteSpace: "nowrap",
              }}
            >
              {fmt(datos.kw)}
            </span>
            {hayDatoKwf && (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "bold",
                  color: textoKwf,
                  whiteSpace: "nowrap",
                }}
              >
                {fmtPorcentaje(pctKwf)}
              </span>
            )}
          </button>

          <button
            onClick={() => onClickMetrica(datos, "cargati")}
            style={{
              position: "relative",
              zIndex: 1,
              width: "50%",
              background: "transparent",
              border: "none",
              padding: "2px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              alignItems: "center",
              cursor: "pointer",
              minWidth: 0,
              boxSizing: "border-box",
            }}
          >
            <span
              style={{
                fontSize: "8px",
                fontWeight: "bold",
                color: TEXTO_CARGA_TI,
                textTransform: "uppercase",
                whiteSpace: "nowrap",
                opacity: 0.85,
              }}
            >
              Carga TI
            </span>
            <span
              style={{
                fontSize: "13px",
                fontWeight: "bold",
                color: TEXTO_CARGA_TI,
                whiteSpace: "nowrap",
              }}
            >
              {fmt(datos.cargaTiKw)}
            </span>
            {hayDatoCargaTi && (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: "bold",
                  color: TEXTO_CARGA_TI,
                  whiteSpace: "nowrap",
                }}
              >
                {fmtPorcentaje(datos.cargaTi)}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// --- TARJETA CHILLER ---
const TarjetaChiller = ({ datos }) => {
  if (!datos) return <div style={{ height: "100%", width: "100%" }}></div>;
  const statusList = datos.statusCompresores || [];

  return (
    <div
      style={{
        backgroundColor: "var(--bg-card)",
        borderRadius: "12px",
        boxShadow: "var(--shadow-card)",
        border: "1px solid var(--border-card)",
        borderTop: "2px solid var(--border-card)",
        padding: "8px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        height: "100%",
        width: "100%",
        minHeight: 0,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--border-subtle)",
          paddingBottom: "4px",
          flexShrink: 0,
        }}
      >
        <h2
          style={{
            fontSize: "12px",
            fontWeight: "bold",
            color: "var(--text-primary)",
            margin: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "50%",
          }}
        >
          {datos.equipo || "Chiller"}
        </h2>
        <div
          style={{
            fontSize: "9px",
            color: "var(--badge-text)",
            backgroundColor: "var(--badge-bg)",
            padding: "1px 4px",
            borderRadius: "4px",
            border: "1px solid var(--badge-border)",
            display: "flex",
            gap: "2px",
          }}
        >
          <span>Comp:</span>
          {statusList.length > 0 ? (
            statusList.map((st, idx) => (
              <span key={idx} style={{ fontWeight: "bold", color: "var(--text-secondary)" }}>
                [{st || "—"}]
              </span>
            ))
          ) : (
            <span>—</span>
          )}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          flex: 1,
          minHeight: 0,
          marginTop: "6px",
        }}
      >
        <div
          style={{
            width: "calc(50% - 3px)",
            marginRight: "6px",
            backgroundColor: "var(--metric-chiller-surt-bg)",
            border: "1px solid var(--metric-chiller-surt-border)",
            borderRadius: "8px",
            padding: "4px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            minHeight: 0,
            boxSizing: "border-box",
          }}
        >
          <span
            style={{
              fontSize: "9px",
              fontWeight: "bold",
              color: "var(--text-muted)",
              textTransform: "uppercase",
            }}
          >
            T° Surtidor
          </span>
          <span
            style={{ fontSize: "15px", fontWeight: "bold", color: "var(--metric-chiller-surt-text)" }}
          >
            {fmt(datos.tempSurtidor, "°C")}
          </span>
        </div>
        <div
          style={{
            width: "calc(50% - 3px)",
            backgroundColor: "var(--metric-chiller-ret-bg)",
            border: "1px solid var(--metric-chiller-ret-border)",
            borderRadius: "8px",
            padding: "4px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            minHeight: 0,
            boxSizing: "border-box",
          }}
        >
          <span
            style={{
              fontSize: "9px",
              fontWeight: "bold",
              color: "var(--text-muted)",
              textTransform: "uppercase",
            }}
          >
            T° Retorno
          </span>
          <span
            style={{ fontSize: "15px", fontWeight: "bold", color: "var(--metric-chiller-ret-text)" }}
          >
            {fmt(datos.tempRetorno, "°C")}
          </span>
        </div>
      </div>
    </div>
  );
};

// --- TARJETA ENERGÍA ---
// NOTA (fix parpadeo): igual que en TarjetaClima, ya no recibe `parpadeoOn`.
const TarjetaEnergia = ({ datos, onClickMetrica }) => {
  if (!datos) return <div style={{ height: "100%", width: "100%" }}></div>;

  const pctCarga = datos.porcentajeCarga;
  const hayDatoCarga = pctCarga !== undefined && pctCarga !== null;
  const cargaCritica = hayDatoCarga && pctCarga >= UMBRAL_CARGA_UPS;
  const colorCarga = hayDatoCarga
    ? cargaCritica
      ? COLOR_PREOCUPANTE
      : COLOR_ENERGIA_OK
    : null;
  // Color plano (sin transparencia) y su texto de contraste correspondiente
  const textoCarga = colorCarga ? getContrastText(colorCarga) : "var(--metric-chiller-surt-text)";

  const claseUps = cargaCritica ? "efecto-baliza" : "";

  return (
    <div
      style={{
        backgroundColor: "var(--bg-card)",
        borderRadius: "12px",
        boxShadow: "var(--shadow-card)",
        border: "1px solid var(--border-card)",
        borderTop: "2px solid #f59e0b",
        padding: "8px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        height: "100%",
        width: "100%",
        minHeight: 0,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--border-subtle)",
          paddingBottom: "4px",
          flexShrink: 0,
        }}
      >
        <h2
          style={{
            fontSize: "12px",
            fontWeight: "bold",
            color: "var(--text-primary)",
            margin: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "55%",
          }}
        >
          {datos.equipo || "UPS"}
        </h2>
        <span
          style={{
            fontSize: "12px",
            color: "var(--badge-text)",
            backgroundColor: "var(--badge-bg)",
            padding: "2px 6px",
            borderRadius: "4px",
            border: "1px solid var(--badge-border)",
            whiteSpace: "nowrap",
          }}
        >
          KVA:{" "}
          <strong style={{ color: "var(--header-energia)" }}>{fmt(datos.kvaInicio)}</strong>
        </span>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          flex: 1,
          minHeight: 0,
          marginTop: "6px",
        }}
      >
        <button
          onClick={() => onClickMetrica(datos, "energia")}
          style={{
            width: "calc(50% - 3px)",
            marginRight: "6px",
            backgroundColor: COLOR_UPS_KW,
            border: `1px solid ${COLOR_UPS_KW}`,
            boxShadow: `0 0 10px 1px ${hexA(COLOR_UPS_KW, 0.45)}`,
            borderRadius: "8px",
            padding: "4px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            cursor: "pointer",
            minHeight: 0,
            boxSizing: "border-box",
          }}
        >
          <span
            style={{
              fontSize: "9px",
              fontWeight: "bold",
              color: TEXTO_UPS_KW,
              textTransform: "uppercase",
              opacity: 0.85,
            }}
          >
            KW
          </span>
          <span
            style={{
              fontSize: "15px",
              fontWeight: "bold",
              color: TEXTO_UPS_KW,
            }}
          >
            {fmt(datos.kvaTermino)}
          </span>
        </button>

        {/* % CARGA UPS - fondo plano (sin transparencia) con el color de
            estado a máxima saturación; el parpadeo a rojo lo hace la clase
            .efecto-baliza, reforzado con un halo (box-shadow) del mismo
            color para que se note más en TVs viejas. */}
        <button
          onClick={() => onClickMetrica(datos, "energia")}
          className={claseUps}
          style={{
            width: "calc(50% - 3px)",
            backgroundColor: colorCarga || "var(--badge-bg)",
            border: `1px solid ${colorCarga || "var(--badge-border)"}`,
            boxShadow: colorCarga
              ? `0 0 12px 1px ${hexA(colorCarga, cargaCritica ? 0.8 : 0.45)}`
              : "none",
            borderRadius: "8px",
            padding: "4px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            cursor: "pointer",
            minHeight: 0,
            boxSizing: "border-box",
          }}
        >
          <span
            style={{
              fontSize: "9px",
              fontWeight: "bold",
              color: textoCarga,
              textTransform: "uppercase",
              opacity: 0.85,
            }}
          >
            % Carga
          </span>
          <span
            style={{ fontSize: "15px", fontWeight: "bold", color: textoCarga }}
          >
            {fmtPorcentaje(pctCarga)}
          </span>
        </button>
      </div>
    </div>
  );
};

// --- VISTA PRINCIPAL ---
const IcetelProgramaVista = () => {
  // Inicializamos leyendo del localStorage del navegador si existe para que cargue AL INSTANTE (0 segundos)
  const [datosClima, setDatosClima] = useState(() => {
    try {
      const guardado = localStorage.getItem(STORAGE_KEY + "_clima");
      return guardado ? JSON.parse(guardado) : [];
    } catch (e) {
      return [];
    }
  });

  const [datosEnergia, setDatosEnergia] = useState(() => {
    try {
      const guardado = localStorage.getItem(STORAGE_KEY + "_energia");
      return guardado ? JSON.parse(guardado) : [];
    } catch (e) {
      return [];
    }
  });

  const [novedades, setNovedades] = useState(() => {
    try {
      const guardado = localStorage.getItem(STORAGE_KEY + "_novedades");
      return guardado ? JSON.parse(guardado) : [];
    } catch (e) {
      return [];
    }
  });

  const [paginaActual, setPaginaActual] = useState(0);
  // Si ya tenemos datos guardados en el navegador, arrancamos diciendo que NO estamos cargando desde cero
  const [cargando, setCargando] = useState(() => datosClima.length === 0);
  const [error, setError] = useState(false);

  // Modo Claro / Oscuro con persistencia
  const [tema, setTema] = useState(() => {
    try {
      return localStorage.getItem("icetel_tema") || "light";
    } catch (e) {
      return "light";
    }
  });

  const alternarTema = useCallback(() => {
    setTema((prev) => {
      const nuevo = prev === "light" ? "dark" : "light";
      try {
        localStorage.setItem("icetel_tema", nuevo);
      } catch (e) { }
      document.documentElement.setAttribute("data-theme", nuevo);
      return nuevo;
    });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", tema);
  }, [tema]);

  // FIX PARPADEO: se elimina el estado `parpadeoOn` y su setInterval de
  // 800ms. Ya no hace falta: el parpadeo ahora es una animación CSS pura
  // (@keyframes) aplicada vía className en las tarjetas, así que no hay
  // re-render de todo el árbol cada 800ms (más liviano en TVs viejas) y no
  // hay dos mecanismos (JS + CSS) peleando por el mismo color.

  const [modalActivo, setModalActivo] = useState(null);
  const abrirDetalle = (sala, metrica) =>
    setModalActivo({ tipo: "detalle", sala, metrica });
  const abrirNovedades = () => setModalActivo({ tipo: "novedades" });
  const cerrarModal = () => setModalActivo(null);

  const intervaloRef = useRef(null);
  const timeoutDatosRef = useRef(null);
  const fallosSeguidosRef = useRef(0);
  const touchInicioX = useRef(null);
  const touchInicioY = useRef(null);
  const { columnas, esPantallaGrande } = useResponsiveLayout();
  const margenInferior = esPantallaGrande ? 18 : 14;
  const [climaRef, alturaDisponibleClima] = useAlturaDisponible(margenInferior);
  const [energiaRef, alturaDisponibleEnergia] =
    useAlturaDisponible(margenInferior);

  useEffect(() => {
    let viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) {
      viewport = document.createElement("meta");
      viewport.name = "viewport";
      document.head.appendChild(viewport);
    }
    viewport.setAttribute(
      "content",
      "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no",
    );
  }, []);

  const cargarDatos = useCallback(async () => {
    try {
      const res = await fetch(GAS_URL);
      const texto = await res.text();

      let json;
      try {
        json = JSON.parse(texto);
      } catch (errorParseo) {
        console.error("Respuesta no era JSON válido:", texto.slice(0, 200));
        throw new Error("Respuesta no válida del servidor");
      }

      if (!json.ok) throw new Error(json.error || "Error desconocido");

      const salas = json.salas || [];
      let chillers = json.chillers || [];
      chillers.sort((a, b) => (a.equipo || "").localeCompare(b.equipo || ""));

      const indiceInicioPanel3 = ITEMS_POR_PAGINA * 2;
      let salasModificadas = [...salas];
      while (salasModificadas.length < indiceInicioPanel3) {
        salasModificadas.push(null);
      }

      const salasPanel1y2 = salasModificadas.slice(0, indiceInicioPanel3);
      const salasRestantes = salasModificadas.slice(indiceInicioPanel3);
      const climaCombinado = [...salasPanel1y2, ...chillers, ...salasRestantes];
      const listaEnergia = json.energia || json.ups || [];
      const listaNovedades = json.novedades || [];

      // Actualizamos estado
      setDatosClima(climaCombinado);
      setDatosEnergia(listaEnergia);
      setNovedades(listaNovedades);
      fallosSeguidosRef.current = 0;
      setError(false);

      // GUARDAMOS EN LOCALSTORAGE DEL NAVEGADOR PARA RECUPERAR AL INSTANTE EN EL FUTURO
      try {
        localStorage.setItem(
          STORAGE_KEY + "_clima",
          JSON.stringify(climaCombinado),
        );
        localStorage.setItem(
          STORAGE_KEY + "_energia",
          JSON.stringify(listaEnergia),
        );
        localStorage.setItem(
          STORAGE_KEY + "_novedades",
          JSON.stringify(listaNovedades),
        );
      } catch (e) {
        // Ignorar si el almacenamiento local está desactivado o lleno
      }
    } catch (err) {
      fallosSeguidosRef.current += 1;
      console.error(
        `Fallo al cargar datos (intento seguido #${fallosSeguidosRef.current}):`,
        err.message,
      );
      if (fallosSeguidosRef.current >= FALLOS_CONSECUTIVOS_PARA_AVISAR) {
        setError(true);
      }
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    let activo = true;
    const ciclo = async () => {
      if (!activo) return;
      await cargarDatos();
      if (!activo) return;
      const espera =
        INTERVALO_DATOS_MS + Math.floor(Math.random() * JITTER_MAX_MS);
      timeoutDatosRef.current = setTimeout(ciclo, espera);
    };
    ciclo();
    return () => {
      activo = false;
      if (timeoutDatosRef.current) clearTimeout(timeoutDatosRef.current);
    };
  }, [cargarDatos]);

  const totalPaginas = Math.max(
    1,
    Math.ceil(
      Math.max(datosClima.length, datosEnergia.length) / ITEMS_POR_PAGINA,
    ),
  );

  useEffect(() => {
    if (paginaActual >= totalPaginas) setPaginaActual(0);
  }, [totalPaginas, paginaActual]);

  const reiniciarRotacion = useCallback(() => {
    if (intervaloRef.current) clearInterval(intervaloRef.current);
    if (totalPaginas <= 1) return;
    intervaloRef.current = setInterval(() => {
      setPaginaActual((p) => (p + 1) % totalPaginas);
    }, INTERVALO_PAGINA_MS);
  }, [totalPaginas]);

  useEffect(() => {
    reiniciarRotacion();
    return () => {
      if (intervaloRef.current) clearInterval(intervaloRef.current);
    };
  }, [reiniciarRotacion]);

  useEffect(() => {
    const manejarTeclado = (ev) => {
      if (totalPaginas <= 1) return;
      if (ev.key === "ArrowRight" || ev.key === "ArrowDown") {
        ev.preventDefault();
        setPaginaActual((p) => (p + 1) % totalPaginas);
        reiniciarRotacion();
      } else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
        ev.preventDefault();
        setPaginaActual((p) => (p - 1 + totalPaginas) % totalPaginas);
        reiniciarRotacion();
      }
    };
    window.addEventListener("keydown", manejarTeclado);
    return () => window.removeEventListener("keydown", manejarTeclado);
  }, [totalPaginas, reiniciarRotacion]);

  // NUEVO: cambio de panel al deslizar (swipe) con el dedo, pensado para
  // celulares en portrait donde no hay teclado físico. Escucha touchstart
  // y touchend sobre el contenedor principal.
  useEffect(() => {
    const UMBRAL_SWIPE_PX = 50; // distancia mínima horizontal para contar como swipe
    const TOLERANCIA_VERTICAL_PX = 60; // si se mueve mucho en vertical, se asume scroll, no swipe

    const manejarTouchStart = (ev) => {
      if (totalPaginas <= 1) return;
      const touch = ev.touches[0];
      touchInicioX.current = touch.clientX;
      touchInicioY.current = touch.clientY;
    };

    const manejarTouchEnd = (ev) => {
      if (totalPaginas <= 1 || touchInicioX.current === null) return;
      const touch = ev.changedTouches[0];
      const deltaX = touch.clientX - touchInicioX.current;
      const deltaY = touch.clientY - touchInicioY.current;

      touchInicioX.current = null;
      touchInicioY.current = null;

      // Si el movimiento vertical fue mayor que el umbral, probablemente el
      // usuario estaba haciendo scroll, no un swipe de cambio de panel.
      if (Math.abs(deltaY) > TOLERANCIA_VERTICAL_PX) return;
      if (Math.abs(deltaX) < UMBRAL_SWIPE_PX) return;

      if (deltaX < 0) {
        // swipe hacia la izquierda -> siguiente panel
        setPaginaActual((p) => (p + 1) % totalPaginas);
      } else {
        // swipe hacia la derecha -> panel anterior
        setPaginaActual((p) => (p - 1 + totalPaginas) % totalPaginas);
      }
      reiniciarRotacion();
    };

    const contenedor = document.getElementById("icetel-contenedor-principal");
    if (!contenedor) return;

    contenedor.addEventListener("touchstart", manejarTouchStart, {
      passive: true,
    });
    contenedor.addEventListener("touchend", manejarTouchEnd, { passive: true });

    return () => {
      contenedor.removeEventListener("touchstart", manejarTouchStart);
      contenedor.removeEventListener("touchend", manejarTouchEnd);
    };
  }, [totalPaginas, reiniciarRotacion]);

  const indiceInicio = paginaActual * ITEMS_POR_PAGINA;
  const indiceFin = indiceInicio + ITEMS_POR_PAGINA;
  const climaEnPantalla = datosClima.slice(indiceInicio, indiceFin);
  const energiaEnPantalla = datosEnergia.slice(indiceInicio, indiceFin);
  const filasVisiblesClima = Math.max(
    1,
    Math.ceil(climaEnPantalla.length / (columnas || 1)),
  );
  const filasVisiblesEnergia = Math.max(
    1,
    Math.ceil(energiaEnPantalla.length / (columnas || 1)),
  );

  const gapColumnas = 8;
  const gapFilas = 18;
  const anchoTarjeta = `calc(${100 / columnas}% - ${(gapColumnas * (columnas - 1)) / columnas}px)`;
  const filas = esPantallaGrande
    ? Math.max(1, Math.ceil(ITEMS_POR_PAGINA / columnas))
    : null;

  const calcularAltoTarjetaPx = (alturaDisponible) => {
    if (!esPantallaGrande) return null;
    if (!alturaDisponible || !filas) return 130;
    const alto = (alturaDisponible - gapFilas * (filas - 1)) / filas;
    return Math.max(70, Math.floor(alto));
  };
  const altoTarjetaClima = calcularAltoTarjetaPx(alturaDisponibleClima);
  const altoTarjetaEnergia = calcularAltoTarjetaPx(alturaDisponibleEnergia);

  return (
    <div
      id="icetel-contenedor-principal"
      style={{
        width: "100%",
        height: "100dvh",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        backgroundColor: "var(--bg-app)",
        padding: esPantallaGrande ? "14px" : "10px",
        boxSizing: "border-box",
        color: "var(--text-primary)",
        fontFamily: "sans-serif",
        display: "flex",
        flexDirection: "column",
        transition: "background-color 0.25s ease, color 0.25s ease",
      }}
    >
      {/* FIX PARPADEO: animación CSS pura. Corre en el compositor del
          navegador, no depende del hilo principal de JS ni de setInterval,
          así que no la throttlea el navegador en TVs/Android viejos cuando
          la pestaña está en segundo plano o sin interacción. El blink ahora
          también pulsa el halo (box-shadow) para que se note en TVs con
          mal contraste. */}
      <style>
        {`
          @keyframes parpadeo-baliza {
            0%, 100% { background-color: ${COLOR_PREOCUPANTE}; border-color: #ff4d5e; box-shadow: 0 0 18px 4px ${hexA(COLOR_PREOCUPANTE, 0.9)}; }
            50% { background-color: transparent; border-color: inherit; box-shadow: 0 0 2px 0 ${hexA(COLOR_PREOCUPANTE, 0.2)}; }
          }
          .efecto-baliza {
            animation: parpadeo-baliza 1.2s infinite;
          }
        `}
      </style>

      {/* HEADER */}
      <div
        style={{
          display: "flex",
          flexDirection: esPantallaGrande ? "row" : "column",
          justifyContent: "space-between",
          alignItems: esPantallaGrande ? "center" : "flex-start",
          marginBottom: "10px",
          borderBottom: "1px solid var(--border-subtle)",
          paddingBottom: "8px",
          flexShrink: 0,
        }}
      >
        <div style={{ marginBottom: esPantallaGrande ? 0 : "8px" }}>
          <h1
            style={{
              fontSize: esPantallaGrande ? "18px" : "16px",
              fontWeight: "bold",
              color: "var(--text-primary)",
              margin: 0,
            }}
          >
            Icetel Visualización
          </h1>
          <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: 0 }}>
            {cargando
              ? "Cargando..."
              : `Panel ${paginaActual + 1} de ${totalPaginas} (Rotación 10s)`}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center" }}>
          <button
            onClick={alternarTema}
            title={tema === "light" ? "Cambiar a Modo Oscuro" : "Cambiar a Modo Claro"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              backgroundColor: "var(--bg-card)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-card)",
              boxShadow: "var(--shadow-card)",
              fontWeight: "bold",
              padding: "6px 12px",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "12px",
              marginRight: "10px",
              transition: "all 0.2s ease",
            }}
          >
            <span style={{ fontSize: "13px" }}>{tema === "light" ? "🌙" : "☀️"}</span>
            <span>{tema === "light" ? "Modo Oscuro" : "Modo Claro"}</span>
          </button>
          <button
            onClick={abrirNovedades}
            style={{
              backgroundColor: "#06b6d4",
              color: "#020617",
              fontWeight: "bold",
              padding: "6px 12px",
              borderRadius: "6px",
              border: "none",
              cursor: "pointer",
              fontSize: "12px",
              marginRight: "10px",
            }}
          >
            Novedades ({novedades.length})
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              backgroundColor: "var(--bg-card)",
              padding: "6px 10px",
              borderRadius: "6px",
              border: "1px solid var(--border-card)",
              boxShadow: "var(--shadow-card)",
              fontSize: "11px",
              fontWeight: "bold",
              color: error ? "#f59e0b" : "#10b981",
              cursor: "pointer",
            }}
          >
            {error ? "Reconectando..." : "EN LÍNEA"}
          </button>
        </div>
      </div>

      {/* CONTENEDOR PRINCIPAL */}
      <div
        style={{
          display: "flex",
          flexDirection: esPantallaGrande ? "row" : "column",
          flex: esPantallaGrande ? 1 : undefined,
          minHeight: esPantallaGrande ? 0 : undefined,
          width: "100%",
        }}
      >
        {/* COLUMNA CLIMA */}
        <div
          style={{
            flex: esPantallaGrande ? 1 : undefined,
            display: "flex",
            flexDirection: "column",
            minHeight: esPantallaGrande ? 0 : undefined,
            marginBottom: esPantallaGrande ? 0 : "18px",
          }}
        >
          <h2
            style={{
              fontSize: "13px",
              fontWeight: "bold",
              marginBottom: "8px",
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: "var(--header-clima)",
              borderBottom: "2px solid var(--header-clima-border)",
              paddingBottom: "4px",
              margin: "0 0 8px 0",
              flexShrink: 0,
            }}
          >
            Clima
          </h2>
          <div
            ref={climaRef}
            style={{
              display: "flex",
              flexWrap: "wrap",
              height: esPantallaGrande
                ? `${alturaDisponibleClima || altoTarjetaClima * filas + gapFilas * (filas - 1)}px`
                : undefined,
              alignContent: "flex-start",
            }}
          >
            {climaEnPantalla.map((item, i) => {
              const esUltimaColumna = i % columnas === columnas - 1;
              const esUltimaFila =
                Math.floor(i / columnas) === filasVisiblesClima - 1;
              const contenido = !item ? null : item.tipo === "chiller" ? (
                <TarjetaChiller key={item.id || `chiller-${i}`} datos={item} />
              ) : (
                <TarjetaClima
                  key={item.id || `sala-${i}`}
                  datos={item}
                  onClickMetrica={abrirDetalle}
                />
              );
              return (
                <div
                  key={`clima-slot-${i}`}
                  style={{
                    width: anchoTarjeta,
                    height: altoTarjetaClima
                      ? `${altoTarjetaClima}px`
                      : undefined,
                    minHeight: altoTarjetaClima ? undefined : "110px",
                    marginRight: esUltimaColumna ? 0 : `${gapColumnas}px`,
                    marginBottom: esUltimaFila ? 0 : `${gapFilas}px`,
                    boxSizing: "border-box",
                  }}
                >
                  {contenido}
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={
            esPantallaGrande
              ? {
                width: "24px",
                flexShrink: 0,
                display: "flex",
                justifyContent: "center",
              }
              : {
                height: "26px",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
              }
          }
        >
          <div
            style={
              esPantallaGrande
                ? {
                  width: "2px",
                  height: "100%",
                  backgroundColor: "var(--divider)",
                  borderRadius: "2px",
                }
                : {
                  height: "2px",
                  width: "100%",
                  backgroundColor: "var(--divider)",
                  borderRadius: "2px",
                }
            }
          ></div>
        </div>

        {/* COLUMNA ENERGÍA */}
        <div
          style={{
            flex: esPantallaGrande ? 1 : undefined,
            display: "flex",
            flexDirection: "column",
            minHeight: esPantallaGrande ? 0 : undefined,
          }}
        >
          <h2
            style={{
              fontSize: "13px",
              fontWeight: "bold",
              marginBottom: "8px",
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: "var(--header-energia)",
              borderBottom: "2px solid var(--header-energia-border)",
              paddingBottom: "4px",
              margin: "0 0 8px 0",
              flexShrink: 0,
            }}
          >
            Energía
          </h2>
          <div
            ref={energiaRef}
            style={{
              display: "flex",
              flexWrap: "wrap",
              height: esPantallaGrande
                ? `${alturaDisponibleEnergia || altoTarjetaEnergia * filas + gapFilas * (filas - 1)}px`
                : undefined,
              alignContent: "flex-start",
            }}
          >
            {energiaEnPantalla.map((ups, i) => {
              const esUltimaColumna = i % columnas === columnas - 1;
              const esUltimaFila =
                Math.floor(i / columnas) === filasVisiblesEnergia - 1;
              const contenido = !ups ? null : (
                <TarjetaEnergia
                  key={ups.id || `ups-${i}`}
                  datos={ups}
                  onClickMetrica={abrirDetalle}
                />
              );
              return (
                <div
                  key={`energia-slot-${i}`}
                  style={{
                    width: anchoTarjeta,
                    height: altoTarjetaEnergia
                      ? `${altoTarjetaEnergia}px`
                      : undefined,
                    minHeight: altoTarjetaEnergia ? undefined : "110px",
                    marginRight: esUltimaColumna ? 0 : `${gapColumnas}px`,
                    marginBottom: esUltimaFila ? 0 : `${gapFilas}px`,
                    boxSizing: "border-box",
                  }}
                >
                  {contenido}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {modalActivo?.tipo === "detalle" && (
        <ModalDetalle
          config={{ sala: modalActivo.sala, metrica: modalActivo.metrica }}
          onClose={cerrarModal}
        />
      )}
      {modalActivo?.tipo === "novedades" && (
        <ModalNovedades
          novedades={novedades}
          onClose={cerrarModal}
          columnaUnica={!esPantallaGrande && columnas < 3}
        />
      )}
    </div>
  );
};

export default IcetelProgramaVista;
