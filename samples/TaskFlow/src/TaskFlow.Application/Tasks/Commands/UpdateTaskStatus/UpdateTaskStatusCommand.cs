using MediatR;
using TaskFlow.Domain.Enums;

namespace TaskFlow.Application.Tasks.Commands.UpdateTaskStatus;

public record UpdateTaskStatusCommand(int TaskId, AppTaskStatus NewStatus) : IRequest;
