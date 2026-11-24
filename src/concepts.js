// The 5 concepts from the assignment. `text` is given to the model word for word.
export const CONCEPTS = [
  {
    id: 1,
    slug: 'pythagoras',
    title: "Pythagoras' theorem",
    subject: 'Maths',
    text: 'In a right-angled triangle, the longest side is called the hypotenuse. The square of the hypotenuse is equal to the sum of the squares of the other two sides: a² + b² = c².',
  },
  {
    id: 2,
    slug: 'circle-parts',
    title: 'Parts of a circle',
    subject: 'Maths',
    text: 'A circle has a centre. The radius is the distance from the centre to the edge. The diameter goes across the circle through the centre and is twice the radius. The circumference is the distance around the circle.',
  },
  {
    id: 3,
    slug: 'series-circuit',
    title: 'Series circuit',
    subject: 'Physics',
    text: 'In a series circuit there is only one loop. The current is the same everywhere in the loop. The voltage of the cell is shared between the components.',
  },
  {
    id: 4,
    slug: 'photosynthesis',
    title: 'Photosynthesis',
    subject: 'Biology',
    text: 'Plants take in carbon dioxide and water. They use light energy, absorbed by chlorophyll, to make glucose and oxygen.',
  },
  {
    id: 5,
    slug: 'states-of-matter',
    title: 'States of matter',
    subject: 'Chemistry',
    text: 'In a solid the particles are close together and vibrate in place. In a liquid they are close but move past each other. In a gas they are far apart and move fast.',
  },
];

export const getConcept = (id) => CONCEPTS.find((c) => c.id === Number(id));
