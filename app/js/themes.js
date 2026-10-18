// Color themes for the memory slots. Published, mostly colour-blind-safe
// qualitative palettes: Paul Tol (tol-colors 2.2.0), Okabe & Ito, ColorBrewer
// (Harrower & Brewer 2003), Tableau 10, Nord.
export const THEMES = [
  { name: 'Tol high contrast', colors: ['#004488', '#BB5566', '#DDAA33'] },
  { name: 'Nord aurora', colors: ['#BF616A', '#D08770', '#EBCB8B', '#A3BE8C', '#B48EAD'] },
  { name: 'Tol medium contrast', colors: ['#6699CC', '#004488', '#EECC66', '#997700', '#EE99AA', '#994455'] },
  { name: 'Tol pale', colors: ['#BBCCEE', '#FFCCCC', '#CCDDAA', '#EEEEBB', '#CCEEFF', '#DDDDDD'] },
  { name: 'Tol bright', colors: ['#4477AA', '#EE6677', '#228833', '#CCBB44', '#66CCEE', '#AA3377', '#BBBBBB'] },
  { name: 'Tol vibrant', colors: ['#EE7733', '#0077BB', '#33BBEE', '#EE3377', '#CC3311', '#009988', '#BBBBBB'] },
  { name: 'Okabe–Ito', colors: ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7', '#000000'] },
  { name: 'ColorBrewer Dark2', colors: ['#1B9E77', '#D95F02', '#7570B3', '#E7298A', '#66A61E', '#E6AB02', '#A6761D', '#666666'] },
  { name: 'ColorBrewer Set2', colors: ['#66C2A5', '#FC8D62', '#8DA0CB', '#E78AC3', '#A6D854', '#FFD92F', '#E5C494', '#B3B3B3'] },
  { name: 'Tol muted', colors: ['#CC6677', '#332288', '#DDCC77', '#117733', '#88CCEE', '#882255', '#44AA99', '#999933', '#AA4499'] },
  { name: 'Tol light', colors: ['#77AADD', '#EE8866', '#EEDD88', '#FFAABB', '#99DDFF', '#44BB99', '#BBCC33', '#AAAA00', '#DDDDDD'] },
  { name: 'Tableau 10', colors: ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC'] },
];

// New documents start with Okabe–Ito minus its black (black is a fixed swatch).
export const defaultPalette = () => THEMES.find(t => t.name === 'Okabe–Ito').colors.slice(0, 7)
  .map((color, i) => ({ id: `s${i + 1}${Math.random().toString(36).slice(2, 6)}`, name: `slot ${i + 1}`, color }));
