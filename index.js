const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);
const APP_NAME = 'turazzunk.hu';
const nodemailer = require('nodemailer');
const request = require('request-promise');
const gmailEmail = functions.config().gmail.email;
const gmailPassword = functions.config().gmail.password;
const mailTransport = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: gmailEmail,
    pass: gmailPassword,
  },
});

exports.archiveDB = functions.https.onRequest((req, res) => {
  admin.database().ref('/events').once('value').then(snapshot => {
    const events = convertToArray(snapshot);

    filteredEvents = events.filter(event => event.date < Date.now() / 1000);

    filteredEvents.map(filteredEvent => {
      admin.database().ref(`/archives/events/${filteredEvent.key}`).set(filteredEvent).then(() => {
        admin.database().ref(`/events/${filteredEvent.key}`).remove().then(() => {
            return true;
        });
      });
    });
    res.send('OK!');
  });  
})

exports.getUserEmail = functions.https.onRequest((req, res) => {
  const ids = req.query.ids.split(",");
  const emails = [];
  const promises = [];
  ids.map(id => {
    promises.push(admin.auth().getUser(id));
  });
  Promise.all(promises).then(values => {
    values.map(value => {
      emails.push(value.email);
    });
    console.log(emails);
    res.send(emails);
  }).catch(error => {
    res.send(error);
    console.log(error);
  })
})

exports.sendNewMessageEmail = functions.https.onRequest((req, res) => { 
  
  let modifiedRelations;

  Promise.all([
    admin.database().ref('/chat_friend_list').once('value'),
    admin.database().ref(`/users`).once('value')
  ]).then(values => {
    
    const relations = [];
    const users = [];

    values[0].forEach(user => {
      const userId = user.key;
      user.forEach(friend => {
        const friendId = friend.key;
        const friendVal = friend.val();
        friendVal.user = userId;
        friendVal.friend = friendId;
        relations.push(friendVal);
      })
    });

    values[1].forEach(user => {
      users.push(user);
    });

    modifiedRelations = relations.filter(elem => elem.sendEmail && elem.newMessage).map(relation => {
      const toUser = users.filter(user => user.val().id === relation.user);
      if (toUser.length > 0) {
        relation.userNick = toUser[0].val().nick;
        relation.userId = toUser[0].key;
      } else {
        relation = null;
      }
      return relation;
    });

    const promises = [];
    modifiedRelations.map(modifiedRelation => {
      promises.push(admin.auth().getUser(modifiedRelation.userId));
    });

    return Promise.all(promises);
  }).then(values => {
    const mailParams = modifiedRelations.map(function(modifiedRelation, index) {
      modifiedRelation.userEmail = values[index].email;
      return modifiedRelation;
    }, values);
    
    const mailOptions = {
      subject: `%{nickFrom}% új üzenetet írt neked a ${APP_NAME}-on!`,
      html: `<h4>Szia %{nickTo}%!</h4> <p><strong>%{nickFrom}%</strong> új üzenetet küldött. Az üzenetet az oldalon, bejelentkezés után tudod megnézni. Az oldalra innen tudsz átugrani:</p><a style="display: inline-block; padding: 10px 20px; background-color: rgb(19, 68, 204); margin: 20px 0; text-decoration: none; border-radius: 5px; color: white" href="https://turazzunk.hu">Tovább az oldalra...</a><p>Üdv: ${APP_NAME} </p>`,
      mailList: []
    }
    mailParams.map(user => {
      mailOptions.mailList.push({mailTo: user.userEmail, nickTo: user.userNick, nickFrom: user.nick});
    });
    
    return request(
      { method: 'POST', 
        uri: "https://turazzunk.hu/sendMailFromCloud.php",
        body: mailOptions, 
        json: true
      }
    );
  }).then(body => {
    console.log(body);
    const modifySendEmail = [];
    const sentEmails = body.success ? body.success.split(', ') : [];
    if (sentEmails.length > 0) {
      modifiedRelations.filter(relation => sentEmails.indexOf(relation.userEmail) > -1).map(relation => {
        modifySendEmail.push(admin.database().ref(`/chat_friend_list/${relation.user}/${relation.friend}`).update({sendEmail: false}));
      })
    }
    return modifySendEmail;
  }).then(modifySendEmail => {
    Promise.all(modifySendEmail).then(() => {
      res.send('sendEmail modified');
    });
  });
});

exports.sendNewItemEmail = functions.database.ref('/items/{id}').onCreate(event => {
  return getDataAndSendMail('Items', event).then(body => {
    console.log(body)
  }).catch(err => {
    console.log(err)
  });
});

exports.sendNewEventEmail = functions.database.ref('/events/{id}').onCreate(event => {
  return getDataAndSendMail('Events', event).then(body => {
    console.log(body)
  }).catch(err => {
    console.log(err)
  });
});

exports.userProfileUpdated = functions.database.ref('/users/{id}').onUpdate(user => {
  const userId = user.data.key;
  /********************************************************************************************/
  const userBefore = user.data.previous.val();
  const userAfter = user.data.val();
  
  if (userBefore.nick !== userAfter.nick || userBefore.picUrl !== userAfter.picUrl) {
    
    const chatRoomPromise = admin.database().ref('/chat/room').once('value').then(roomList => {
      
      const rooms = convertToArray(roomList);

      rooms.map(room => {
        const messageIds = Object.keys(room);
        const filteredMessageIds = messageIds.filter(messageId => {
          if (room[messageId].userId === userId) {
            return true;
          }
        });
        if (filteredMessageIds.length > 0) {
          filteredMessageIds.map(filteredMessageId => {
            if (userBefore.nick !== userAfter.nick) {
              admin.database().ref(`chat/room/${room.key}/${filteredMessageId}`).update({userName: userAfter.nick});
            }
            if (userBefore.picUrl !== userAfter.picUrl) {
              admin.database().ref(`chat/room/${room.key}/${filteredMessageId}`).update({userPicUrl: userAfter.picUrl});
            }
          });
        }
      });
    });

    const chatPrivateRoomPromise = admin.database().ref('/chat/chat_list').once('value').then(privateRooms => {
      const filteredPrivateRooms = [];
      privateRooms.forEach(privateRoom => {
        room = privateRoom.val();
        room.key = privateRoom.key;
        if (room.key.indexOf(userId) > -1) {
          filteredPrivateRooms.push(room);
        }
      });
      filteredPrivateRooms.map(room => {
        const messageIds = Object.keys(room);
        const filteredMessageIds = messageIds.filter(messageId => {
          if (room[messageId].userId === userId) {
            return true;
          }
        });
        if (filteredMessageIds.length > 0) {
          filteredMessageIds.map(filteredMessageId => {
            if (userBefore.nick !== userAfter.nick) {
              admin.database().ref(`chat/chat_list/${room.key}/${filteredMessageId}`).update({userName: userAfter.nick});
            }
            if (userBefore.picUrl !== userAfter.picUrl) {
              admin.database().ref(`chat/chat_list/${room.key}/${filteredMessageId}`).update({userPicUrl: userAfter.picUrl});
            }
          });
        }
      });
    });

    const chatFriendListPromise = admin.database().ref(`/chat_friend_list/${userId}`).once('value').then(snapshot => {
      const friendsToUpdate = [];
      snapshot.forEach(childSnapshot => {
        const friendToUpdate = childSnapshot.key; 
        friendsToUpdate.push(friendToUpdate);
      });
      return friendsToUpdate;
    }).then(friendsToUpdate => {
      friendsToUpdate.map(friend => {
        if (userBefore.nick !== userAfter.nick) {
          admin.database().ref(`/chat_friend_list/${friend}/${userId}`).update({nick: userAfter.nick});
        }
        if (userBefore.picUrl !== userAfter.picUrl) {
          admin.database().ref(`/chat_friend_list/${friend}/${userId}`).update({picUrl: userAfter.picUrl});
        }
      });
    });
        
    return Promise.all([chatRoomPromise, chatPrivateRoomPromise, chatFriendListPromise]).then(() => {
      console.log('all updates done!');
    }).catch(reason => {
      console.log(reason);
    });
  } else {
    console.log('nothing to update.');
    return 'ok'
  }
});

exports.userProfileDeleted = functions.database.ref('/users/{id}/').onDelete(snapshot => { 
  /************************************************************************************/
  const user = snapshot.data.previous.val();
  let events = [];
  
  const itemsPromise = admin.database().ref('/items').once('value').then(snapshot => {
    const items = convertToArray(snapshot);
    return items;
  }).then(items => {
    filteredItems = items.filter(item => item.creatorId === user.id);
    filteredItems.map(filteredItem => {
      admin.database().ref(`/items/${filteredItem.key}`).remove();
    });
  });

  const eventsPromise = admin.database().ref('/events').once('value').then(snapshot => {
    events = convertToArray(snapshot);
  }).then(() => {
    filteredEvents = events.filter(event => event.hasOwnProperty('guestsIds') && event.guestsIds.hasOwnProperty(user.id));
    filteredEvents.map(filteredEvent => {
      admin.database().ref(`/events/${filteredEvent.key}/guestsIds/${user.id}`).remove();
    });
  }).then(() => {
    filteredEvents = events.filter(event => event.creatorId === user.id);
    filteredEvents.map(filteredEvent => {
      admin.database().ref(`/events/${filteredEvent.key}`).remove();
    });
  });

  const chatFriendListPromise = admin.database().ref(`/chat_friend_list/${user.id}`).once('value').then(snapshot => {
    const friendsToUpdate = [];
    snapshot.forEach(childSnapshot => {
      const friendToUpdate = childSnapshot.key; 
      friendsToUpdate.push(friendToUpdate);
    });
    return friendsToUpdate;
  }).then(friendsToUpdate => {
    friendsToUpdate.map(friend => {
      admin.database().ref(`/chat_friend_list/${friend}/${user.id}`).remove();
    });
  }).then(() => admin.database().ref(`/chat_friend_list/${user.id}`).remove());

  const chatListPromise = admin.database().ref(`chat/chat_list`).once('value').then(snapshot => {
    const chatListItems = [];
    snapshot.forEach(childSnapshot => {
      const chatListItem = childSnapshot.key;
      chatListItems.push(chatListItem);
    });
    filteredItems = chatListItems.filter(chatListItem => chatListItem.indexOf(user.id) > -1);
    filteredItems.map(filteredItem => {
      admin.database().ref(`/chat/chat_list/${filteredItem}`).remove();
    });
  });  
  
  const chatRoomPromise = admin.database().ref('/chat/room').once('value').then(roomList => {
    const rooms = convertToArray(roomList);
    rooms.map(room => {
      const messageIds = Object.keys(room);
      const filteredMessageIds = messageIds.filter(messageId => {
        if (room[messageId].userId === user.id) {
          return true;
        }
      });
      if (filteredMessageIds.length > 0) {
        filteredMessageIds.map(filteredMessageId => {
          admin.database().ref(`chat/room/${room.key}/${filteredMessageId}`).update({userName: 'Törölt'});
          admin.database().ref(`chat/room/${room.key}/${filteredMessageId}`).update({userPicUrl: '../assets/vector/deletedUser.svg'})
        });
      }
    });
  });

  const categoriesPromises = [];
  favEvents = user.favEvents ? Object.keys(user.favEvents) : [];
  favItems = user.favItems ? Object.keys(user.favItems) : [];
  
  favEvents.map(favEvent => {
    categoriesPromises.push(admin.database().ref(`/categories/EventsCategories/${favEvent}/${user.id}`).remove());
  });
  favItems.map(favItem => {
    categoriesPromises.push(admin.database().ref(`/categories/ItemsCategories/${favItem}/${user.id}`).remove());
  });

  return Promise.all([eventsPromise, itemsPromise, chatFriendListPromise, chatListPromise, chatRoomPromise, Promise.all(categoriesPromises)]).then(() => {
    console.log('all deletes done!');
  }).catch(reason => {
    console.log(reason);
  });
});

exports.itemDeleted = deleteChatRoomOnDeleteEventOrItem('event');

exports.eventDeleted = deleteChatRoomOnDeleteEventOrItem('event');

function deleteChatRoomOnDeleteEventOrItem(eventOrItem) {
  return functions.database.ref(`/${eventOrItem}s/{id}/`).onDelete(snapshot => {
    const id = snapshot.data.previous.key;
    return admin.database().ref(`/chat/room/${id}`).remove().then(() => {
      console.log(`${eventOrItem}ChatRoom deleted`);
    }).catch(reason => {
      console.log(reason);
    });
  });
}

function getDataAndSendMail(whereFrom, createEvent) {
  const element = createEvent.data.val(); 
  const category = element.category; 
  const elementId = createEvent.data.key;
  const elementTitle = element.title;
  const elementDir = whereFrom === 'Items' ? 'cuccok' : 'turak';
  const elementWhat = whereFrom === 'Items' ? 'cucc' : 'túra';
  let filteredUsers = [];

  const getUsersMailTo = admin.database().ref(`/categories/${whereFrom}Categories/${category}`).once('value');

  const getAllUsers = admin.database().ref(`/users`).once('value');
  
  return Promise.all([getUsersMailTo, getAllUsers]).then(values => {
    let userIds = [];
    let users = [];
    
    values[0].forEach(childSnapshot => {
      const userId = childSnapshot.key; 
      userIds.push(userId);
    });
    
    values[1].forEach(childSnapshot => {
      let user = childSnapshot.val(); 
      users.push(user);
    });
    
    filteredUsers = users.filter(user => userIds.indexOf(user.id) > -1);
    const promises = [];
    
    filteredUsers.map(user => {
      promises.push(admin.auth().getUser(user.id));
    });
  
    return Promise.all(promises);
  
  }).then(values => {
    let mappedUsers = [];
    
    emails = values.map(value => value.email);
    names = filteredUsers.map(user => user.nick);
    
    mappedUsers = emails.map(function(email, index) {
      return {
        userEmail: email,
        userName: names[index]
      }
    }, names);
    
    return mappedUsers;
  }).then(mappedUsers => {
    const mailOptions = {
      subject: `Új ${category} a ${APP_NAME}-on!`,
      html: `<h4>Szia %{nickTo}%!</h4> <p>Az oldalra új ${elementWhat} került fel a <strong>${category}</strong> kategóriába <strong>"${elementTitle}"</strong> néven. Nézd meg a részleteket itt:</p><a style="display: inline-block; padding: 10px 20px; background-color: rgb(19, 68, 204); margin: 20px 0; text-decoration: none; border-radius: 5px; color: white" href="https://turazzunk.hu/${elementDir}/view/${elementId}">Tovább a(z) "${elementTitle}" részleteihez...</a><p>Üdv: ${APP_NAME}</p>`,
      mailList: []
    }
    mappedUsers.map(user => {
      mailOptions.mailList.push({mailTo: user.userEmail, nickTo: user.userName});
    });
    
    return request(
      { method: 'POST', 
        uri: "https://turazzunk.hu/sendMailFromCloud.php",
        body: mailOptions, 
        json: true
      }
    )
  });
}

function convertToArray(object) {
  const elements = [];
  object.forEach(oneElement => {
    const element = oneElement.val(); 
    element.key = oneElement.key;
    elements.push(element);
  });
  return elements;
}

exports.sendMail = functions.https.onRequest((req, res) => {
  const mail = [];
  mail.push({"mailTo": "info@uvegszilank.hu", "nickTo": "Eva2", });
  const resp = {};
  resp.mail = mail;
  resp.text = 'text';
  resp.subject = "Ez itt egy tárgy mező";
  request(
    { method: 'POST', 
      uri: "https://turazzunk.hu/sendMailFromCloud.php",
      body: resp, 
      json: true
    },
    (error, response, body) => {
      if(response.statusCode == 200){
        console.log(response.body);
        console.log(response);
        res.send(body);
      }
    }
  )
});