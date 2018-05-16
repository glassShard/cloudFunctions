const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);
const APP_NAME = 'Túrázzunk!';
const nodemailer = require('nodemailer');
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
    let events = [];
    snapshot.forEach(childSnapshot => {
      let event = childSnapshot.val(); 
      event.key = childSnapshot.key;
      events.push(event);
    });

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

exports.sendNewMessageEmail = functions.https.onRequest((req, res) => {
  
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

    const modifiedRelations = relations.filter(elem => elem.sendEmail && elem.newMessage).map(relation => {
      const toUser = users.filter(user => user.val().id === relation.user);
      if (toUser.length > 0) {
        relation.userEmail = toUser[0].val().email;
        relation.userNick = toUser[0].val().nick;
      } else {
        relation = null;
      }
      return relation;
    });

    return modifiedRelations;
  }).then(modifiedRelations => {
    
    const mailOptions = {
      from: `${APP_NAME} <noreply@turazzunk.hu>`
    };
    
    const emails = modifiedRelations.map(relation => {
      mailOptions.to = relation.userEmail;
      mailOptions.subject = `${relation.nick} új üzenetet írt neked a ${APP_NAME}-on!`
      mailOptions.html = `<h4>Szia ${relation.userNick || ''}!</h4> <p><strong>${relation.nick}</strong> új üzenetet küldött. Az üzenetet az oldalon, bejelentkezés után tudod megnézni. Az oldalra innen tudsz átugrani:</p><a style="display: inline-block; padding: 10px 20px; background-color: rgb(19, 68, 204); margin: 20px 0; text-decoration: none; border-radius: 5px; color: white" href="localhost:4200">Tovább az oldalra...</a><p>${APP_NAME} mert túrázni jó!</p>`;
      
      return mailTransport.sendMail(mailOptions);
    });

    return Promise.all(emails)
    .then(values => {
      console.log(values);
      const modifySendEmail = [];
      modifiedRelations.map(relation => {
        modifySendEmail.push(admin.database().ref(`/chat_friend_list/${relation.user}/${relation.friend}`).update({sendEmail: false}));
      });
      return modifySendEmail;
    }).then(modifySendEmail => {
      Promise.all(modifySendEmail).then(() => {
        res.send('sendEmail modified');
      });
    });
  }); 
});

exports.sendNewItemEmail = functions.database.ref('/items/{id}').onCreate(event => {
  return getDataAndSendMail('Items', event).then(() => console.log('Function completed'));
});

exports.sendNewEventEmail = functions.database.ref('/events/{id}').onCreate(event => {
  return getDataAndSendMail('Events', event).then(() => console.log('Function completed'));
});

exports.userProfileUpdated = functions.database.ref('/users/{id}').onUpdate(user => {
  const userId = user.data.key;
  /********************************************************************************************/
  const userBefore = user.data.previous.val();
  const userAfter = user.data.val();
  
  if (userBefore.nick !== userAfter.nick || userBefore.picUrl !== userAfter.picUrl) {
    
    const chatRoomPromise = admin.database().ref('/chat/room').once('value').then(roomList => {
      const rooms = [];
      roomList.forEach(oneRoom => {
        const room = oneRoom.val(); 
        room.key = oneRoom.key;
        rooms.push(room);
      });
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
        
    return Promise.all([chatRoomPromise, chatPrivateRoomPromise]).then(() => {
      console.log('all updates done!');
    }).catch(reason => {
      console.log(reason);
    });
  } else {
    console.log('nothing to update.');
    return 'ok'
  }
})

exports.userProfileDeleted = functions.database.ref('/users/{id}/').onDelete(snapshot => {
  /************************************************************************************/
  const user = snapshot.data.previous.val();
  const events = [];
  
  const itemsPromise = admin.database().ref('/items').once('value').then(snapshot => {
    let items = [];
    snapshot.forEach(childSnapshot => {
      let item = childSnapshot.val(); 
      item.key = childSnapshot.key;
      items.push(item);
    });
    return items;
  }).then(items => {
    filteredItems = items.filter(item => item.creatorId === user.id);
    const itemCreatorIdPromises = [];
    filteredItems.map(filteredItem => {
      itemCreatorIdPromises.push(admin.database().ref(`/items/${filteredItem.key}`).remove())
    });
    return Promise.all(itemCreatorIdPromises);
  });

  const eventsPromise = admin.database().ref('/events').once('value').then(snapshot => {
    snapshot.forEach(childSnapshot => {
      const event = childSnapshot.val(); 
      event.key = childSnapshot.key;
      events.push(event);
    });
  }).then(() => {
    filteredEvents = events.filter(event => event.hasOwnProperty('guestsIds') && event.guestsIds.hasOwnProperty(user.id));
    const eventGuestIdPromises = [];
    filteredEvents.map(filteredEvent => {
      eventGuestIdPromises.push(admin.database().ref(`/events/${filteredEvent.key}/guestsIds/${user.id}`).remove());
    });
    return Promise.all(eventGuestIdPromises);
  }).then(() => {
    filteredEvents = events.filter(event => event.creatorId === user.id);
    const eventCreatorIdPromises = [];
    filteredEvents.map(filteredEvent => {
      eventCreatorIdPromises.push(admin.database().ref(`/events/${filteredEvent.key}`).remove());
    });
    return  Promise.all(eventCreatorIdPromises);
  });

  const chatFriendListPromise = admin.database().ref(`/chat_friend_list/${user.id}`).once('value').then(snapshot => {
    const friendsToUpdate = [];
    snapshot.forEach(childSnapshot => {
      const friendToUpdate = childSnapshot.key; 
      friendsToUpdate.push(friendToUpdate);
    });
    return friendsToUpdate;
  }).then(friendsToUpdate => {
    const friendsToUpdatePromises = [];
    friendsToUpdate.map(friend => {
      friendsToUpdatePromises.push(admin.database().ref(`/chat_friend_list/${friend}/${user.id}`)
      .remove());
    });
    return Promise.all(friendsToUpdatePromises);
  }).then(() => admin.database().ref(`/chat_friend_list/${user.id}`).remove());

  const chatListPromise = admin.database().ref(`chat/chat_list`).once('value').then(snapshot => {
    const chatListItems = [];
    snapshot.forEach(childSnapshot => {
      const chatListItem = childSnapshot.key;
      chatListItems.push(chatListItem);
    });
    filteredItems = chatListItems.filter(chatListItem => chatListItem.indexOf(user.id) > -1);
    const chatListDeletePromises = [];
    filteredItems.map(filteredItem => {
      chatListDeletePromises.push(admin.database().ref(`/chat/chat_list/${filteredItem}`).remove());
    });
    return Promise.all(chatListDeletePromises);
  })

  return Promise.all([eventsPromise, itemsPromise, chatFriendListPromise, chatListPromise]).then(() => {
    console.log('all deletes done!');
  }).catch(reason => {
    console.log(reason);
  });
});

function getDataAndSendMail(whereFrom, createEvent) {
  const element = createEvent.data.val(); 
  const category = element.category; 
  const elementId = createEvent.data.key;
  const elementTitle = element.title;
  const elementDir = whereFrom === 'Items' ? 'cuccok' : 'turak';
  const elementWhat = whereFrom === 'Items' ? 'cucc' : 'túra';

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
    mappedUsers = filteredUsers.map(user => {
      return {
        userEmail: user.email,
        userName: user.nick 
      }
    });
    return mappedUsers;

  }).then(mappedUsers => {
    const mailOptions = {
      from: `${APP_NAME} <noreply@turazzunk.hu>`,
      subject: `Új ${category} a ${APP_NAME}-on!`
    }
    
    const emails = mappedUsers.map(user => {
      mailOptions.to = user.userEmail;
      mailOptions.html = `<h4>Szia ${user.userName || ''}!</h4> <p>Az oldalra új ${elementWhat} került fel a <strong>${category}</strong> kategóriába <strong>"${elementTitle}"</strong> néven. Nézd meg a részleteket itt:</p><a style="display: inline-block; padding: 10px 20px; background-color: rgb(19, 68, 204); margin: 20px 0; text-decoration: none; border-radius: 5px; color: white" href="localhost:4200/${elementDir}/view/${elementId}">Tovább a(z) "${elementTitle}" részleteihez...</a><p>${APP_NAME} mert túrázni jó!</p>`;
      
      return mailTransport.sendMail(mailOptions);
    });
    
    return Promise.all(emails).then(
      values => console.log(values),
      reason => console.log(reason)
    );
  });
}