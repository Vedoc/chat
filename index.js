const PORT = process.env.SOCKET_PORT || 8080
const HOST = process.env.SOCKET_HOST || '0.0.0.0'
const APP_PORT = process.env.APP_PORT || '3000'
const MONGO_USER = process.env.MONGO_USER
const MONGO_PASSWORD = process.env.MONGO_PASSWORD
const MONGO_HOST = process.env.MONGO_HOST || 'mongo'
const MONGO_DB = process.env.MONGO_DB
const APP_HOST = process.env.APP_HOST || 'app'
const APP_URL = `http://${APP_HOST}:${APP_PORT}`
const MONGO_URL = `mongodb://${MONGO_USER}:${MONGO_PASSWORD}@${MONGO_HOST}`;
const PAGE_SIZE = process.env.PAGE_SIZE || 30

const mongo = require('mongodb').MongoClient
const ObjectId = require('mongodb').ObjectID
const io = require('socket.io')({
  serveClient: false,
  pingInterval: 10000,
  pingTimeout: 5000,
  cookie: false
})
const http = require('http')
const server = http.createServer()
const request = require('request').defaults({
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
})

let clients = {}

// Use connect method to connect to the server
mongo.connect(MONGO_URL, { useNewUrlParser: true }, function(err, client) {
  if (err) {
    throw err
  }

  // Run socket server
  server.listen(PORT, HOST);

  const socketServer = io.listen(server)

  socketServer.use(function(socket, next) {
    // Authentication
    const handshakeData = socket.handshake.query
    const tokens = {}

    console.log('Auth middleware!', socket.id)

    Object.keys(handshakeData).forEach(function(key) {
      if (['access-token', 'client', 'uid'].includes(key)) {
        tokens[key] = handshakeData[key]
      }
    })

    if (Object.keys(tokens).length === 0) {
      return next(new Error())
    }

    request({ url: `${APP_URL}/v1/auth/validate_token`, qs: tokens }, function (error, response, body) {
      if (error || !response || response.statusCode != 200) {
        console.log('Invalid response')
        return next(new Error())
      }

      parsedBody = JSON.parse(body)

      if (parsedBody['account']) {
        clients[socket.id] = {}
        clients[socket.id]['data'] = parsedBody['account']
        clients[socket.id]['tokens'] = tokens

        return next()
      }

      next(new Error())
    })
  }).on('connection', function(socket) {
    console.log('Client has been connected!', socket.id)

    const db = client.db(MONGO_DB)
    const chat = db.collection('chats')

    function currentUser() {
      return clients[socket.id]
    }

    // Send unread messages count
    chat.aggregate([
      { '$match': { read: false, to_id: currentUser().data.accountable_id, to_type: currentUser().data.accountable_type }},
      {
        '$group': {
        '_id': {
            'offer_id': '$offer_id',
            'service_request_id': '$service_request_id'
          },
          'count': { '$sum': 1 }
        }
      },
      {
        '$project': {
          '_id': false,
          'count': true,
          'offer_id': '$_id.offer_id',
          'service_request_id': '$_id.service_request_id'
        }
      }
    ]).toArray(function(err, res) {
      if (err) {
        console.log(err)
        return
      }

      socket.emit('unreadMessages', res)
    })

    // Handle input events
    socket.on('input', function(data, fn) {
      if (!currentUser() || !currentUser().recepient) {
        return fn({ status: 'error', error: 'You have not joined to the room' })
      }

      const recepient = currentUser().recepient
      const message = data.message
      const offerId = recepient.offer.id // Use to identify room
      const roomName = `room${offerId}`

      // Check for room
      const socketInRoom = Object.values(socket.rooms).find(function(room) {
        return room === roomName
      })

      if (socketInRoom && message && offerId) {
        let recepientSocket = null

        socketServer.in(roomName).clients((error, roomClients) => {
          if (error) {
            fn({ status: 'error', error: 'Cannot get room clients' })
            return
          }

          recepientSocket = roomClients.find((socketId) => {
            return socketId !== socket.id
          })

          const messageObject = {
            read: Boolean(recepientSocket),
            message: message,
            offer_id: offerId,
            service_request_id: recepient.offer.service_request_id,
            to_type: recepient.accountable_type,
            to_id: recepient.accountable_id,
            from_type: currentUser().data.accountable_type,
            from_id: currentUser().data.accountable_id
          }
  
          chat.insertOne(messageObject, function(error, response) {
            if (error) {
              fn({ status: 'error', error: 'Message cannot be sent' })
            } else {
              const roomId = `room${offerId}`
              const responseObj = mongoMessage(response.ops[0])
  
              fn({ status: 'success', message: responseObj })

              if (recepientSocket) {
                // When recepient in the room
                socket.broadcast.to(roomId).emit('newRoomMessage', responseObj);
              } else {
                // Send Push
                pushData = {
                  recepient: {
                    accountable_id: recepient.accountable_id,
                    accountable_type: recepient.accountable_type
                  },
                  message: responseObj
                }

                request.post({ url: `${APP_URL}/internal/notifications/new_message`, qs: pushData }, function (error, response, body) {
                  console.log('Push Notification: ', response.statusCode)
                })

                recepientSocket = Object.keys(clients).find(socketId => {
                  return clients[socketId].data.accountable_id === recepient.accountable_id &&
                         clients[socketId].data.accountable_type === recepient.accountable_type
                })

                if (recepientSocket) {
                  socketServer.to(recepientSocket).emit('newMessage', responseObj)
                }
              }
            }
          })
        });
      } else {
        fn({ status: 'error', error: 'Invalid message params' })
      }
    })

    // Handle getting messages
    socket.on('getMessages', function(data, fn) {
      if (!currentUser() || !currentUser().recepient) {
        return fn({ status: 'error', error: 'You have not joined to the room' })
      }

      const recepient = currentUser().recepient
      const lastMessageId = data.id
      const offerId = recepient.offer.id

      messagesAggregation(chat, offerId, lastMessageId).toArray(function(err, res) {
        if (err) {
          fn({status: 'error', error: 'Error while getting messages'})
        } else {
          res[0].data.map(function(msg) {
            return mongoMessage(msg)
          })

          fn({
            status: 'success',
            last_page: isLastPage(res[0].total),
            messages: res[0].data.reverse()
          })
        }
      })
    })

    // Handle joining chat
    socket.on('joinRoom', function(data, fn) {
      const offerId = data.offer_id
      clients[socket.id].recepient = null

      request({
        url: `${APP_URL}/internal/recepient?offer_id=${offerId}`,
        headers: currentUser().tokens
      }, function (error, response, body) {
        if (error || !response || response.statusCode != 200) {
          fn({status: 'error', error: 'You do not have enough permissions to join to the room'})
          return
        }
        parsedBody = JSON.parse(body)

        socket.join(`room${offerId}`, function(error) {
          if (!error) {
            // Set messages as read
            chat.updateMany(
              { offer_id: offerId, to_id: currentUser().data.accountable_id, to_type: currentUser().data.accountable_type, read: false },
              { '$set': { read: true } }, function(error) {
              if (!error) {
                // Get chats from mongo collection
                messagesAggregation(chat, offerId).toArray(function(err, res) {
                  if (err) {
                    fn({status: 'error', error: 'Error while getting messages from database'})
                    return
                  }

                  clients[socket.id].recepient = parsedBody.recepient
                  res[0].data.map(function(msg) {
                    return mongoMessage(msg)
                  })

                  // Emit the messages
                  fn({
                    status: 'success',
                    last_page: isLastPage(res[0].total),
                    messages: res[0].data.reverse(),
                    recepient: parsedBody.recepient
                  })
                })
              } else {
                fn({status: 'error', error: 'Error while getting messages from database'})
              }
            })
          } else {
            fn({status: 'error', error: 'Error while updating messages'})
          }
        })
      })
    })

    socket.on('leaveRoom', function(data, fn) {
      const roomName = `room${data.offer_id}`
      clients[socket.id].recepient = null

      socket.leave(roomName, function(error) {
        if (error) {
          fn({status: 'error', error: `Cannot leave '${roomName}'`})
        } else {
          fn({ status: 'success', messages: 'Successfully left the room' })
        }
      })
    })

    socket.on('disconnect', function () {
      delete clients[socket.id]
      console.log('Disconnected!')
    });

    // socket.close()
  });

  console.log(`Running on ${HOST}:${PORT}`)
});

function mongoMessage(obj) {
  obj['created_at'] = obj._id.getTimestamp()
  obj['_id'] = obj._id.toString()

  return obj
}

function messagesAggregation(chat, offerId, lastMessageId = null) {
  let matchAggregators =  [{ offer_id: { '$eq': offerId }}]

  if (lastMessageId) {
    matchAggregators.unshift({
      _id: { '$lt': new ObjectId(lastMessageId) }
    })
  }

  return chat.aggregate([
    {
      '$facet': {
        data: [
          { '$match': { '$and': matchAggregators } },
          { '$sort': { _id: -1 } },
          { '$limit': PAGE_SIZE }
        ],
        total: [{ $count: 'count' }]
      }
    }
  ])
}

function isLastPage(total) {
  return (total.length > 0) ? (total[0].count <= PAGE_SIZE) : true
}
