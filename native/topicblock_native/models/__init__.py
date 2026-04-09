"""
TopicBlock model interfaces and registry.

Public API
----------
    from topicblock_native.models import ITopicModel, ISentimentModel, registry
    from topicblock_native.models import NullTopicModel, NullSentimentModel
"""

from topicblock_native.models.base import (
    ISentimentModel,
    ITopicModel,
    NullSentimentModel,
    NullTopicModel,
)
from topicblock_native.models.registry import ModelRegistry, registry

__all__ = [
    "ITopicModel",
    "ISentimentModel",
    "NullTopicModel",
    "NullSentimentModel",
    "ModelRegistry",
    "registry",
]
