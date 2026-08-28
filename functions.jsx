async function ini() {
  const myPonyCard = cards?.MainCharacter?.[0]
  const myPonyCardData = functions.getCardData(myPonyCard)
  if (myPonyCardData) {
    game.data.Character.image = myPonyCardData.face.front.image

    const ponyName = myPonyCardData.name?.toLowerCase().replace(/\s+/g, "")
    console.log(ponyName, myPonyCardData) 
    const colorKey = Object.keys(colors).find(key => ponyName?.includes(key))
    game.data.Character.color = colors[colorKey] ?? colors.twilight
  }
}

const colors = {
  "twilight": "#A46BBD",
  "applejack": "#EF6F2F",
  "fluttershy": "#E9D461",
  "pinkiepie": "#E880B0",
  "rainbowdash": "#6BABDA",
  "rarity": "#BDC1C2"
}
