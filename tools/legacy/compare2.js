const fs = require('fs');

const tengo = `Una noche más - Walls (feat. Bruses)
Algo que Confesar - Porta (feat. MegaR)
¿Cuál - Walls
IRIS OUT - Kenshi Yonezu
Teletransporte - Noan
En Dos - Noan
Tu Nombre - Noan
ME MATA(S) - Noan
Lo Más Bonito De Lo Más Triste - Almacor & Charlie USG
Cuentos de Hadas - Noan
Mis disculpas - Noan
Llamada Perdida - Morat
Sombras en la Oscuridad - Noan
Anestesiado - Noan
Un carro bonito - Noan
Bailaré - Noan
MI LUGAR - Charlie USG
Podria estar peor ( - Noan
El día que me olvides - Noan
NÁPOLES - Álvaro de Luna
Charles Chevalier Rap (Blue Lock) - Unknown Artist
Loki y Hugo - Uno y Dos (Blue Lock) ZerØ Ft. BynMc
Tan vacío - Walls (feat. Hens)
Qué bien te quedaba - Noan
Complicao - Noan
Todo Mal - Noan
Por Partes - Noan
Volver a verte - Noan
Que se caiga el cielo - Noan
En la Boca de un Lobo - Noan
No Me Siento Yo - Noan
Cerca de Ti - Noan
Reventar la Ciudad - Noan
Mami - Noan
Lo Logré - Noan
Lo Que Nunca Te Dije - Noan
De Enero a Enero - Noan
Sin Ti Todo Sigue Igual - Noan
A Solas - Noan
Desfase - Noan
Los Niños del Parque - Noan
Solo Una Noche Más - Noan
Quédate Conmigo - Noan
Mi Favorita - Noan
No Eres Tú, Soy Yo - Noan
Ojos Azules - Noan
En El Mismo Lugar - Noan
Si Te Vas - Noan
Romper el Hielo - Noan
Quédate un Rato Más - Noan
Todo Cambió - Noan
Fuera de Control - Noan
Mentiras - Noan
Tan Cerca, Tan Lejos - Noan
Mil Razones - Noan
Laberinto - Noan
Aunque Ya No Estés - Noan
Tu Reflejo - Noan
Mi Peor Enemigo - Noan
Volver a Empezar - Noan
Demasiado Tarde - Noan
Luces de la Ciudad - Noan
Sin Mirar Atrás - Noan
No Volveré - Noan
Cristales Rotos - Noan
Un Segundo Más - Noan
Otra Noche - Noan
Eclipse - Noan
Cenizas - Noan
Historias sin Final - Noan
A Contracorriente - Noan
Todo Lo Que Quiero - Noan
Recuerdos - Noan
El Último Adiós - Noan
Bajo la Lluvia - Noan
No Sé Quién Eres - Noan
Cicatrices - Noan
Lejos de Aquí - Noan
Miradas - Noan
Noches Frías - Noan
Qué Más Da - Noan
Sálvame - Noan
Sin Destino - Noan
Al Borde del Abismo - Noan
Cartas de Amor - Noan
Ya No Duele - Noan
En Silencio - Noan
Buscando Respuestas - Noan
Perdido en Ti - Noan
Destino o Casualidad - Noan
Despiértame - Noan
No Puedo Más - Noan
Entre el Amor y el Odio - Noan
Pasado Pisado - Noan
Vuelo Sin Motor - Noan
Déjame Volar - Noan
Un Día Más - Noan
A Través del Cristal - Noan
Última Oportunidad - Noan
Desconectado - Noan
Si Volvieras - Noan
Latidos - Noan
Sin Explicación - Noan
Una Última Canción - Noan
Cicatrices de Guerra - Noan
No Queda Nada - Noan
Fugitivos - Noan
Refugio - Noan
Contra las Cuerdas - Noan
Rumbo Fijo - Noan
Huellas en la Arena - Noan
Al Final del Camino - Noan
Sin Salida - Noan
Punto y Aparte - Noan
Marioneta - Noan
Gritos Sordos - Noan
Renacer - Noan
Instantes - Noan
A Corazón Abierto - Noan
Último Segundo - Noan
Pasos Perdidos - Noan
Luces y Sombras - Noan
El Eco de tu Voz - Noan
I WANNA BE YOUR SLAVE - Måneskin
Something to Confess - Nyako ft. MegaR (Prod. by bonnierogerr) Kaoru Hana wa Rin to Saku
Mentirosa - Nyako (Prod. by K4nji) Oshi no Ko (Ai Hoshino)
Ratón de Ciudad - Nyako (Prod. by bonnierogerr) Chainsaw Man (Reze)
¡Guau! - Nyako (Prod. by Cabo Beats) Chainsaw Man (Makima)
Which one - Nyako (Prod. by Cueto on the Beat) OtaGal
Noche - Nyako (Prod. by PutyanLaruny) Yofukashi no Uta (Kyouko MejiroAnko Uguisu)
Vamos - Nyako ft. @NeithanMc (Prod. by BUDI) Yofukashi no Uta
Que Dolor - Nyako (Prod. by Gian Beat & DjGlass) Ao no Hako (Hina)
Más de ti - Nyako (Beat Prod. by Matthew May) Horimiya
Culpa - Nyako (Prod. by Darling Senpai Beats) Oshi no Ko (Aqua)
Peligrosa Cuando - Aurozyz (Official Lyrics Video)
PECADO Y CONDENA - Aurozyz (Official Lyric Video)
Caja de Cristal - Nyako ft. Diestock (Prod. by Rebbel) Ao no Hako (Taiki & Chinatsu)
Copia Perfecta - Nyako (Prod. by Jinno) Oshi no Ko (Akane)
Bailaré - Nyako (Prod. by K4nji) Oshi no Ko (Ruby Hoshino)
Loki y Hugo - Uno y Dos (Blue Lock) ZerØ Ft. BynMc
Confesiones - Porta`.split('\n');

const quiero = `1. **Una noche más** – Walls (feat. Bruses)
2. **¿Cuál?** – Walls
3. **IRIS OUT** – Kenshi Yonezu
4. **Teletransporte** – Noan
5. **En Dos** – Noan
6. **ME MATA(S)** – Noan
7. **Lo Más Bonito De Lo Más Triste** – Almacor & Charlie USG
8. **Mis disculpas** – Noan
9. **Llamada Perdida** – Morat
10. **Anestesiado** – Noan
11. **Un carro bonito** – Noan
12. **Bailaré** – Noan
13. **MI LUGAR** – Charlie USG
14. **Podria estar peor :(** – Noan
15. **El día que me olvides** – Noan
16. **NÁPOLES** – Álvaro de Luna
17. **Charles Chevalier Rap (Blue Lock) | "Diablillo Asesino"** – Lucksterr
18. **Algo que Confesar** – Porta (feat. MegaR)
19. **Tan vacío** – Walls (feat. Hens)
20. **Qué bien te quedaba** – Noan
21. **Complicao** – Noan
22. **Me gustabas más cuando ibas de indie** – Noan
23. **Todo Mal** – Noan
24. **Por Partes** – Noan
25. **Volver a verte** – Noan
26. **Que se caiga el cielo** – Noan
27. **En la Boca de un Lobo** – Noan
28. **No Me Siento Yo** – Noan
29. **Cansado de Estar Triste** – Noan
30. **Cerca de Ti** – Noan
31. **Reventar la Ciudad** – Noan
32. **Mami** – Noan
33. **Lo Logré** – Noan
34. **Lo Que Nunca Te Dije** – Noan
35. **De Enero a Enero** – Noan
36. **Sin Ti Todo Sigue Igual** – Noan
37. **A Solas** – Noan
38. **Desfase** – Noan
39. **Los Niños del Parque** – Noan
40. **Solo Una Noche Más** – Noan
41. **Quédate Conmigo** – Noan
42. **Mi Favorita** – Noan
43. **No Eres Tú, Soy Yo** – Noan
44. **Promesas rotas** – Noan
45. **Ojos Azules** – Noan
46. **En El Mismo Lugar** – Noan
47. **Si Te Vas** – Noan
48. **Romper el Hielo** – Noan
49. **Quédate un Rato Más** – Noan
50. **Todo Cambió** – Noan
51. **Fuera de Control** – Noan
52. **Mentiras** – Noan
53. **Tan Cerca, Tan Lejos** – Noan
54. **Mil Razones** – Noan
55. **Laberinto** – Noan
56. **Aunque Ya No Estés** – Noan
57. **Tu Reflejo** – Noan
58. **Mi Peor Enemigo** – Noan
59. **Volver a Empezar** – Noan
60. **Demasiado Tarde** – Noan
61. **Luces de la Ciudad** – Noan
62. **Sin Mirar Atrás** – Noan
63. **No Volveré** – Noan
64. **Cristales Rotos** – Noan
65. **Un Segundo Más** – Noan
66. **Otra Noche** – Noan
67. **Eclipse** – Noan
68. **Tu Nombre** – Noan
69. **Cenizas** – Noan
70. **Historias sin Final** – Noan
71. **A Contracorriente** – Noan
72. **Todo Lo Que Quiero** – Noan
73. **Recuerdos** – Noan
74. **El Último Adiós** – Noan
75. **Bajo la Lluvia** – Noan
76. **No Sé Quién Eres** – Noan
77. **Cicatrices** – Noan
78. **Lejos de Aquí** – Noan
79. **Miradas** – Noan
80. **Noches Frías** – Noan
81. **Qué Más Da** – Noan
82. **Sálvame** – Noan
83. **Sin Destino** – Noan
84. **Al Borde del Abismo** – Noan
85. **Karma** – Noan
86. **Cartas de Amor** – Noan
87. **Ya No Duele** – Noan
88. **En Silencio** – Noan
89. **Buscando Respuestas** – Noan
90. **Perdido en Ti** – Noan
91. **Destino o Casualidad** – Noan
92. **Despiértame** – Noan
93. **No Puedo Más** – Noan
94. **Entre el Amor y el Odio** – Noan
95. **Pasado Pisado** – Noan
96. **Vuelo Sin Motor** – Noan
97. **Déjame Volar** – Noan
98. **Un Día Más** – Noan
99. **A Través del Cristal** – Noan
100. **Última Oportunidad** – Noan
101. **Desconectado** – Noan
102. **Si Volvieras** – Noan
103. **Latidos** – Noan
104. **Sin Explicación** – Noan
105. **Cuentos de Hadas** – Noan
106. **Una Última Canción** – Noan
107. **Más Allá del Sol** – Noan
108. **Cicatrices de Guerra** – Noan
109. **No Queda Nada** – Noan
110. **Fugitivos** – Noan
111. **Refugio** – Noan
112. **Contra las Cuerdas** – Noan
113. **Rumbo Fijo** – Noan
114. **Huellas en la Arena** – Noan
115. **Al Final del Camino** – Noan
116. **Sin Salida** – Noan
117. **Punto y Aparte** – Noan
118. **Marioneta** – Noan
119. **Sombras en la Oscuridad** – Noan
120. **Gritos Sordos** – Noan
121. **Renacer** – Noan
122. **Instantes** – Noan
123. **A Corazón Abierto** – Noan
124. **Último Segundo** – Noan
125. **Pasos Perdidos** – Noan
126. **Luces y Sombras** – Noan
127. **El Eco de tu Voz** – Noan
128. **I WANNA BE YOUR SLAVE** – Måneskin
129. **Something to Confess** – Nyako ft. MegaR (Prod. by bonnierogerr) *Kaoru Hana wa Rin to Saku*
130. **Mentirosa** – Nyako (Prod. by K4nji) *Oshi no Ko (Ai Hoshino)*
131. **Ratón de Ciudad** – Nyako (Prod. by bonnierogerr) *Chainsaw Man (Reze)*
132. **¡Guau!** – Nyako (Prod. by Cabo Beats) *Chainsaw Man (Makima)*
133. **Which one** – Nyako (Prod. by Cueto on the Beat) *OtaGal*
134. **Noche** – Nyako (Prod. by PutyanLaruny) *Yofukashi no Uta (Kyouko MejiroAnko Uguisu)*
135. **Vamos** – Nyako ft. @NeithanMc (Prod. by BUDI) *Yofukashi no Uta*
136. **Que Dolor** – Nyako (Prod. by Gian Beat & DjGlass) *Ao no Hako (Hina)*
137. **Más de ti** – Nyako (Beat Prod. by Matthew May) *Horimiya*
138. **Culpa** – Nyako (Prod. by Darling Senpai Beats) *Oshi no Ko (Aqua)*
139. **Peligrosa Cuando** – Aurozyz (Official Lyrics Video)
140. **PECADO Y CONDENA** – Aurozyz (Official Lyric Video)
141. **Caja de Cristal** – Nyako ft. Diestock (Prod. by Rebbel) *Ao no Hako (Taiki & Chinatsu)*
142. **Copia Perfecta** – Nyako (Prod. by Jinno) *Oshi no Ko (Akane)*
143. **Bailaré** – Nyako (Prod. by K4nji) *Oshi no Ko (Ruby Hoshino)*
144. **Loki y Hugo - Uno y Dos** (Blue Lock) ZerØ Ft. BynMc`.split('\n').filter(Boolean);

let extra = [];
for (let t of tengo) {
  let tNorm = t.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!quiero.some(q => q.toLowerCase().replace(/[^a-z0-9]/g, '').includes(tNorm))) {
    extra.push(t);
  }
}

console.log("=== EXTRA ===");
console.log(extra.join('\n'));
