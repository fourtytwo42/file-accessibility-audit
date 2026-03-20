import { Router, Response, type IRouter } from 'express'
import { authMiddleware, adminMiddleware, AuthRequest } from '../middleware/authMiddleware.js'
import { getPlaybookDetail, listPlaybooks } from '../services/playbookService.js'

const router: IRouter = Router()

router.get('/playbooks', authMiddleware, adminMiddleware, (_req: AuthRequest, res: Response) => {
  try {
    res.json({ playbooks: listPlaybooks() })
  } catch (err) {
    console.error('Playbooks list error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/playbooks/:id', authMiddleware, adminMiddleware, (req: AuthRequest, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    if (!id) {
      res.status(400).json({ error: 'Playbook id is required' })
      return
    }
    const detail = getPlaybookDetail(id)
    if (!detail.playbook) {
      res.status(404).json({ error: 'Playbook not found' })
      return
    }
    res.json(detail)
  } catch (err) {
    console.error('Playbook detail error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
