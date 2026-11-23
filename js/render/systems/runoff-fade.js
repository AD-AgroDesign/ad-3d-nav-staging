/* Fundido propio del simulador: uSimFade[key] = fundido del escenario SIN el factor de opacidad del diseño, por la opacidad del
   simulador (slider del panel del simulador). Así el slider de la tabla (designOpacity) no aclara el agua/velocidad/diferencia.
   Lo escribe runoff.update(); los shaders lo leen como uFade. */
export const simFade = { inicial: { value: 1 }, multi: { value: 1 } };
