async function ini() {
  const myPonyCard = cards?.MainCharacter?.[0]
  const myPonyCardData = functions.getCardData(myPonyCard)
  if (myPonyCardData) {
    game.data.Character.image = myPonyCardData.face.front.image

    const ponyName = myPonyCardData.name?.toLowerCase().replace(/\s+/g, "")
    const colorKey = Object.keys(colors).find(key => ponyName?.includes(key))
    game.data.Character.color = colors[colorKey] ?? colors.twilight
  }
}

async function onPonyEnter(section, ponies) {
  if (ponies.length <= 0) return
  const sectionData = game.data[section + "_Boost"]
  console.log(sectionData, section, ponies)
  if (!sectionData) return
  const ponyCard = ponies[0]
  const ponyCardData = functions.getCardData(ponyCard)
  sectionData.boost = 4
}

async function onPonyLeft(section) {
  const sectionData = game.data[section + "_Boost"]
  console.log(sectionData, section)
  if (!sectionData) return
  sectionData.boost = 0
}

const colors = {
  "twilight": "#A46BBD",
  "applejack": "#EF6F2F",
  "fluttershy": "#E9D461",
  "pinkiepie": "#E880B0",
  "rainbowdash": "#6BABDA",
  "rarity": "#BDC1C2"
}
