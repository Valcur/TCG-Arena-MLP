async function ini() {
  const myPonyCard = cards?.MainCharacter?.[0]
  const myPonyCardData = functions.getCardData(myPonyCard)
  console.log(myPonyCard, myPonyCardData, cards)
  if (myPonyCardData) {
    game.data.Character.image = myPonyCardData.face.front.image
    game.data.Character.color = "#ffffff"
  }
}